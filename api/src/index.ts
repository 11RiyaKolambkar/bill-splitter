import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

type NameBody = { name: string }

// Reads the request body and returns the name if it is valid, otherwise null.
async function readName(req: Request): Promise<NameBody | null> {
  const body: unknown = await req.json().catch(() => null)
  if (typeof body !== 'object' || body === null || !('name' in body)) return null
  const name = body.name
  if (typeof name !== 'string' || name.trim() === '') return null
  return { name: name.trim() }
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const input = await readName(c.req.raw)
  if (!input) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, input.name).run()

  return c.json({ id, name: input.name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const input = await readName(c.req.raw)
  if (!input) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, position)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM members WHERE home_id = ?))`,
  )
    .bind(id, homeId, input.name, homeId)
    .run()

  return c.json({ id, homeId, name: input.name }, 201)
})
type BillBody = { title: string; totalCents: number }

// Returns the bill input if it is valid, otherwise null.
async function readBill(req: Request): Promise<BillBody | null> {
  const body: unknown = await req.json().catch(() => null)
  if (typeof body !== 'object' || body === null) return null
  if (!('title' in body) || !('totalCents' in body)) return null
  const { title, totalCents } = body
  if (typeof title !== 'string' || title.trim() === '') return null
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents <= 0) {
    return null
  }
  return { title: title.trim(), totalCents }
}

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const input = await readBill(c.req.raw)
  if (!input) {
    return c.json({ error: 'title and a positive whole number totalCents are required' }, 422)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY position',
  )
    .bind(homeId)
    .all<{ id: string }>()
  if (members.length === 0) return c.json({ error: 'home has no members' }, 422)

  // Split: everyone gets the base amount, the first `remainder` members get 1 extra cent.
  const base = Math.floor(input.totalCents / members.length)
  const remainder = input.totalCents % members.length

  const billId = crypto.randomUUID()
  const shares = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: base + (index < remainder ? 1 : 0),
    paidAt: null,
  }))

  // One batch = all statements succeed together or none of them are saved.
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, input.title, input.totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ])

  return c.json(
    { id: billId, homeId, title: input.title, totalCents: input.totalCents, shares },
    201,
  )
})
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS memberId, m.name AS name,
            COALESCE(SUM(s.amount_cents), 0) AS outstandingCents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
     WHERE m.home_id = ?
     GROUP BY m.id
     ORDER BY m.position`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: results }, 200)
})
type ShareRow = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
  idempotencyKey: string | null
}

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  // Only one request can ever succeed: the WHERE paid_at IS NULL check and
  // the update happen in one single SQL statement.
  const paid = await c.env.DB.prepare(
    `UPDATE shares
     SET paid_at = ?, idempotency_key = ?
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL
     RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt`,
  )
    .bind(new Date().toISOString(), key, shareId, billId)
    .first<{ id: string; memberId: string; amountCents: number; paidAt: string }>()

  if (paid) return c.json(paid, 200)

  // Nothing was updated: the share does not exist, or it was already paid.
  const existing = await c.env.DB.prepare(
    `SELECT id, member_id AS memberId, amount_cents AS amountCents,
            paid_at AS paidAt, idempotency_key AS idempotencyKey
     FROM shares WHERE id = ? AND bill_id = ?`,
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (!existing) return c.json({ error: 'bill or share not found' }, 404)

  if (existing.idempotencyKey === key) {
    // Same key sent again: return the same result, do not pay twice.
    return c.json(
      {
        id: existing.id,
        memberId: existing.memberId,
        amountCents: existing.amountCents,
        paidAt: existing.paidAt,
      },
      200,
    )
  }

  return c.json({ error: 'share already paid with a different key' }, 409)
})
type ShareView = {
  id: string
  billId: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<{ id: string; title: string; totalCents: number }>()

  const { results: shares } = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id AS billId, s.member_id AS memberId, m.name AS memberName,
            s.amount_cents AS amountCents, s.paid_at AS paidAt
     FROM shares s
     JOIN bills b ON b.id = s.bill_id
     JOIN members m ON m.id = s.member_id
     WHERE b.home_id = ?
     ORDER BY m.position`,
  )
    .bind(homeId)
    .all<ShareView>()

  return c.json(
    {
      bills: bills.map((bill) => ({
        ...bill,
        shares: shares.filter((share) => share.billId === bill.id),
      })),
    },
    200,
  )
})
export default app
