import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/')({ component: HomePage })

type Share = {
  id: string
  billId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

type Bill = { id: string; title: string; totalCents: number; shares: Share[] }

type Status = 'idle' | 'loading' | 'error' | 'ready'

// Calls the API. Always throws an Error with a readable message, never crashes the page.
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(10000) })
  } catch {
    throw new Error('Could not reach the server, or it took too long. Please try again.')
  }
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Something went wrong (status ${res.status}).`
    throw new Error(message)
  }
  return data as T
}

// Display only: the API always works in whole cents.
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function HomePage() {
  const [homeId, setHomeId] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [bills, setBills] = useState<Bill[]>([])
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payErrors, setPayErrors] = useState<Record<string, string>>({})

  async function load(id: string) {
    if (!id.trim()) return
    setStatus('loading')
    setError('')
    try {
      const data = await api<{ bills: Bill[] }>(`/api/homes/${encodeURIComponent(id.trim())}/bills`)
      setBills(data.bills)
      setStatus('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStatus('error')
    }
  }

  async function pay(share: Share) {
    setPayingId(share.id)
    setPayErrors((prev) => ({ ...prev, [share.id]: '' }))
    try {
      const paid = await api<{ id: string; paidAt: string }>(
        `/api/bills/${share.billId}/shares/${share.id}/pay`,
        { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } },
      )
      // Only mark as paid after the server confirmed it.
      setBills((prev) =>
        prev.map((bill) => ({
          ...bill,
          shares: bill.shares.map((s) => (s.id === paid.id ? { ...s, paidAt: paid.paidAt } : s)),
        })),
      )
    } catch (e) {
      // The share stays unpaid and shows the error.
      setPayErrors((prev) => ({
        ...prev,
        [share.id]: e instanceof Error ? e.message : 'Payment failed',
      }))
    } finally {
      setPayingId(null)
    }
  }

  // Helper so you can test without curl: makes a home, 3 members and one bill.
  async function createDemo() {
    setStatus('loading')
    setError('')
    try {
      const home = await api<{ id: string }>('/api/homes', jsonPost({ name: 'Demo home' }))
      for (const name of ['Asha', 'Ben', 'Chen']) {
        await api(`/api/homes/${home.id}/members`, jsonPost({ name }))
      }
      await api(`/api/homes/${home.id}/bills`, jsonPost({ title: 'Electricity', totalCents: 1000 }))
      setHomeId(home.id)
      await load(home.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStatus('error')
    }
  }

  return (
    <main
      style={{ maxWidth: 640, margin: '2rem auto', padding: '0 1rem', fontFamily: 'sans-serif' }}
    >
      <h1>Shared Bill Splitter</h1>
      <label>
        Home ID <input value={homeId} onChange={(e) => setHomeId(e.target.value)} size={36} />
      </label>{' '}
      <button type="button" onClick={() => load(homeId)} disabled={status === 'loading'}>
        Load bills
      </button>{' '}
      <button type="button" onClick={createDemo} disabled={status === 'loading'}>
        Create demo home
      </button>
      {status === 'idle' && <p>Enter a home ID, or create a demo home.</p>}
      {status === 'loading' && <p>Loading…</p>}
      {status === 'error' && (
        <p role="alert" style={{ color: 'crimson' }}>
          Error: {error}
        </p>
      )}
      {status === 'ready' && bills.length === 0 && <p>This home has no bills yet.</p>}
      {status === 'ready' &&
        bills.map((bill) => (
          <section key={bill.id} style={{ border: '1px solid #ccc', padding: 12, marginTop: 16 }}>
            <h2>
              {bill.title} — {money(bill.totalCents)}
            </h2>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {bill.shares.map((share) => (
                <li key={share.id} style={{ marginBottom: 8 }}>
                  {share.memberName}: {money(share.amountCents)}{' '}
                  {share.paidAt ? (
                    <strong>Paid</strong>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pay(share)}
                      disabled={payingId === share.id}
                    >
                      {payingId === share.id ? 'Paying…' : 'Pay'}
                    </button>
                  )}
                  {payErrors[share.id] && (
                    <div role="alert" style={{ color: 'crimson' }}>
                      {payErrors[share.id]}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </main>
  )
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
