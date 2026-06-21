import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY  = Deno.env.get('RESEND_API_KEY')!
const SB_URL      = Deno.env.get('SUPABASE_URL')!
const SB_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FROM_EMAIL  = Deno.env.get('FROM_EMAIL') ?? 'Lost Pet Finder <onboarding@resend.dev>'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function sendEmail(to: string, subject: string, html: string) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const { type, petId, appUrl } = body
    const admin = createClient(SB_URL, SB_SVC_KEY)

    // ── New listing: notify volunteer spotters ─────────────────────────────────
    if (type === 'new_listing') {
      const { petName, petType, petLat, petLng, petLocation } = body
      const { data: subs } = await admin.from('subscribers').select('*')

      const relevant = (subs ?? []).filter((s: any) => {
        if (!petLat || !petLng || !s.lat || !s.lng) return true
        return haversine(petLat, petLng, s.lat, s.lng) <= (s.radius_km ?? 10)
      })

      await Promise.all(relevant.map((s: any) =>
        sendEmail(
          s.email,
          `🐾 Missing ${petType} reported near you: ${petName}`,
          `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#fff8f2;border-radius:12px">
            <h2 style="color:#e8622a;margin:0 0 8px">New missing pet near you</h2>
            <p style="color:#5a3825;margin:0 0 12px">A <strong>${petType}</strong> named <strong>${petName}</strong> was just reported missing${petLocation ? ` near <strong>${petLocation}</strong>` : ''}.</p>
            <a href="${appUrl ?? ''}" style="display:inline-block;padding:12px 24px;background:#e8622a;color:white;text-decoration:none;border-radius:50px;font-weight:700">
              View listing →
            </a>
            <p style="color:#a07050;font-size:0.8rem;margin-top:24px">You signed up for alerts on Lost Pet Finder. Reply to unsubscribe.</p>
          </div>`
        )
      ))

      return new Response(JSON.stringify({ notified: relevant.length }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ── Sighting / found: notify listing owner ─────────────────────────────────
    const { data: pet } = await admin.from('pets').select('name, type, user_id').eq('id', petId).single()
    if (!pet) return new Response(JSON.stringify({ skipped: 'no pet' }), { headers: cors })

    if (!pet.user_id) return new Response(JSON.stringify({ skipped: 'no owner' }), { headers: cors })

    const { data: { user } } = await admin.auth.admin.getUserById(pet.user_id)
    const ownerEmail = user?.email
    if (!ownerEmail) return new Response(JSON.stringify({ skipped: 'no email' }), { headers: cors })

    let subject = '', html = ''

    if (type === 'sighting') {
      const { sightingMsg, sightingLoc } = body
      subject = `New sighting of ${pet.name}! 🐾`
      html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#fff8f2;border-radius:12px">
        <h2 style="color:#e8622a;margin:0 0 8px">Someone spotted ${pet.name}!</h2>
        <p style="color:#5a3825;margin:0 0 16px">A sighting was just reported on <strong>Lost Pet Finder</strong>.</p>
        ${sightingMsg ? `<div style="background:#fff;border-left:4px solid #e8622a;padding:12px 16px;border-radius:4px;margin-bottom:12px"><strong>What they saw:</strong> ${sightingMsg}</div>` : ''}
        ${sightingLoc ? `<div style="background:#fff;border-left:4px solid #4caf50;padding:12px 16px;border-radius:4px;margin-bottom:12px"><strong>Where:</strong> ${sightingLoc}</div>` : ''}
        <a href="${appUrl ?? ''}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#e8622a;color:white;text-decoration:none;border-radius:50px;font-weight:700">View all sightings →</a>
        <p style="color:#a07050;font-size:0.8rem;margin-top:24px">You received this because you posted this listing.</p>
      </div>`
    } else if (type === 'found') {
      subject = `${pet.name} may have been found! 🎉`
      html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#fff8f2;border-radius:12px">
        <h2 style="color:#4caf50;margin:0 0 8px">Great news about ${pet.name}!</h2>
        <p style="color:#5a3825;margin:0 0 16px">Someone marked <strong>${pet.name}</strong> as found on <strong>Lost Pet Finder</strong>.</p>
        <a href="${appUrl ?? ''}" style="display:inline-block;padding:12px 24px;background:#4caf50;color:white;text-decoration:none;border-radius:50px;font-weight:700">Open Lost Pet Finder →</a>
        <p style="color:#a07050;font-size:0.8rem;margin-top:24px">You received this because you posted this listing.</p>
      </div>`
    } else {
      return new Response(JSON.stringify({ error: 'Unknown type' }), { status: 400, headers: cors })
    }

    const res = await sendEmail(ownerEmail, subject, html)
    const resJson = await res.json()
    return new Response(JSON.stringify(resJson), { status: res.ok ? 200 : 500, headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors })
  }
})
