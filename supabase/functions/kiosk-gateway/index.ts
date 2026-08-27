// Kiosk gateway — the only endpoint a Raspberry Pi attendance kiosk talks to.
// Device authentication is done with a per-device token (sha256 hash stored in kiosk_devices).
// Actions: sync (config + face gallery), events (mark attendance), heartbeat.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-kiosk-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const MATCH_THRESHOLD = 0.45;
const AMBIGUITY_RATIO = 0.82;
const MIN_CONFIDENCE = 0.62;
const TZ = 'Asia/Kolkata';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function euclidean(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function distanceToConfidence(dist: number): number {
  return 1 / (1 + Math.exp(14 * (dist - MATCH_THRESHOLD)));
}

function parseDescriptor(raw: unknown): number[] | null {
  try {
    if (!raw) return null;
    if (typeof raw === 'string') {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? arr.map(Number) : null;
    }
    if (Array.isArray(raw)) return (raw as unknown[]).length ? (raw as unknown[]).map(Number) : null;
    return null;
  } catch { return null; }
}

function minutesInTz(iso?: string): number {
  const d = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

function dayKeyInTz(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function getCutoffMinutes(admin: any): Promise<number> {
  let cutoff = '09:00';
  try {
    const { data } = await admin
      .from('attendance_settings').select('value').eq('key', 'cutoff_time').maybeSingle();
    if (data?.value && /^\d{1,2}:\d{2}/.test(data.value)) cutoff = data.value;
  } catch { /* default */ }
  const [h, m] = cutoff.split(':').map(Number);
  return h * 60 + m;
}

interface Device {
  id: string;
  name: string;
  location: string | null;
  class: string | null;
  section: string | null;
  category: string | null;
}

/** Build the recognition gallery, scoped to the device's class/section when set. */
async function buildGallery(admin: any, device: Device) {
  const { data: rows, error } = await admin
    .from('face_descriptors')
    .select('user_id, descriptor, descriptors, student_name, class, section, category');
  if (error) throw new Error(`gallery load failed: ${error.message}`);

  const userIds = Array.from(new Set((rows || []).map((r: any) => r.user_id).filter(Boolean)));
  const profileMap = new Map<string, any>();
  for (let i = 0; i < userIds.length; i += 400) {
    const chunk = userIds.slice(i, i + 400);
    const { data: profs } = await admin
      .from('profiles')
      .select('user_id, full_name, display_name, email, class, section, category, roll_number')
      .in('user_id', chunk);
    for (const p of profs || []) profileMap.set(p.user_id, p);
  }

  const wantClass = (device.class || '').trim().toLowerCase();
  const wantSection = (device.section || '').trim().toLowerCase();
  const wantCategory = (device.category || '').trim().toLowerCase();

  const perUser = new Map<string, { user_id: string; name: string; class: string | null; section: string | null; descriptors: number[][] }>();

  for (const r of rows || []) {
    if (!r.user_id) continue;
    const p = profileMap.get(r.user_id) || {};
    const cls = (p.class ?? r.class ?? '') as string;
    const sec = (p.section ?? r.section ?? '') as string;
    const cat = (p.category ?? r.category ?? '') as string;

    if (wantClass && cls.trim().toLowerCase() !== wantClass) continue;
    if (wantSection && sec.trim().toLowerCase() !== wantSection) continue;
    if (wantCategory && cat.trim().toLowerCase() !== wantCategory) continue;

    const list: unknown[] = Array.isArray(r.descriptors) ? r.descriptors : (r.descriptor ? [r.descriptor] : []);
    const parsed = list.map(parseDescriptor).filter((d): d is number[] => !!d);
    if (!parsed.length) continue;

    const name = p.full_name || p.display_name || r.student_name || p.email || 'Unknown';
    const entry = perUser.get(r.user_id) || { user_id: r.user_id, name, class: cls || null, section: sec || null, descriptors: [] };
    entry.descriptors.push(...parsed);
    perUser.set(r.user_id, entry);
  }

  return Array.from(perUser.values());
}

type GalleryEntry = Awaited<ReturnType<typeof buildGallery>>[number];

function matchDescriptor(query: number[], gallery: GalleryEntry[]) {
  const q = new Float32Array(query);
  const ranked: { entry: GalleryEntry; dist: number }[] = [];
  for (const entry of gallery) {
    let best = Infinity;
    for (const d of entry.descriptors) {
      if (d.length !== q.length) continue;
      const dist = euclidean(q, new Float32Array(d));
      if (dist < best) best = dist;
    }
    if (Number.isFinite(best)) ranked.push({ entry, dist: best });
  }
  ranked.sort((a, b) => a.dist - b.dist);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.dist > MATCH_THRESHOLD) return { recognized: false as const, reason: 'no_match' };
  if (second && best.dist / second.dist > AMBIGUITY_RATIO) return { recognized: false as const, reason: 'ambiguous' };
  const confidence = Math.max(0, Math.min(1, distanceToConfidence(best.dist)));
  if (confidence < MIN_CONFIDENCE) return { recognized: false as const, reason: 'low_confidence' };
  return { recognized: true as const, entry: best.entry, confidence };
}

async function uploadSnapshot(admin: any, base64: string, userId: string): Promise<string | null> {
  try {
    const clean = base64.includes(',') ? base64.split(',')[1] : base64;
    const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    const path = `kiosk/${dayKeyInTz()}/${userId}-${Date.now()}.jpg`;
    const { error } = await admin.storage.from('attendance-snapshots')
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
    if (error) { console.warn('snapshot upload failed', error.message); return null; }
    const { data: signed } = await admin.storage.from('attendance-snapshots')
      .createSignedUrl(path, 60 * 60 * 24 * 365);
    return signed?.signedUrl || null;
  } catch (e) {
    console.warn('snapshot error', e);
    return null;
  }
}

async function notifyParent(admin: any, userId: string, name: string, status: string, iso: string, deviceName: string) {
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('parent_phone, parent_email, parent_name, display_name, full_name')
      .eq('user_id', userId).maybeSingle();
    if (!profile?.parent_email && !profile?.parent_phone) return;
    const time = new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    const label = name || profile?.full_name || profile?.display_name || 'Your child';
    const body = status === 'late'
      ? `Dear Parent, ${label} arrived late at school at ${time} (${deviceName}). - Presence`
      : `Dear Parent, ${label} has arrived at school at ${time} (${deviceName}). - Presence`;
    await admin.functions.invoke('send-notification', {
      body: {
        recipient: {
          email: profile?.parent_email || null,
          phone: profile?.parent_phone || null,
          name: profile?.parent_name || `Parent of ${label}`,
        },
        message: {
          subject: status === 'late' ? `Late Arrival - ${label}` : `Attendance Confirmation - ${label}`,
          body,
        },
        student: { id: userId, name: label, status },
        targetUserId: userId,
      },
    });
  } catch (e) {
    console.warn('parent notification failed', e);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const token = req.headers.get('x-kiosk-token') || '';
    if (!token || token.length < 20) return json({ error: 'Missing device token' }, 401);

    const tokenHash = await sha256Hex(token);
    const { data: device } = await admin
      .from('kiosk_devices')
      .select('id, name, location, class, section, category, is_active')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!device) return json({ error: 'Unknown device token' }, 401);
    if (!device.is_active) return json({ error: 'Device disabled' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'heartbeat');
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

    await admin.from('kiosk_devices').update({
      last_seen_at: new Date().toISOString(),
      last_ip: ip,
      ...(body?.agentVersion ? { agent_version: String(body.agentVersion).slice(0, 40) } : {}),
    }).eq('id', device.id);

    if (action === 'heartbeat') {
      return json({ ok: true, device: { id: device.id, name: device.name }, serverTime: new Date().toISOString() });
    }

    if (action === 'sync') {
      const [gallery, cutoffMinutes] = await Promise.all([
        buildGallery(admin, device as Device),
        getCutoffMinutes(admin),
      ]);
      const today = dayKeyInTz();
      const { data: marked } = await admin
        .from('attendance_records')
        .select('user_id, status')
        .eq('date', today)
        .in('status', ['present', 'late']);
      return json({
        ok: true,
        device: {
          id: device.id, name: device.name, location: device.location,
          class: device.class, section: device.section, category: device.category,
        },
        cutoffMinutes,
        timezone: TZ,
        matchThreshold: MATCH_THRESHOLD,
        today,
        alreadyMarked: (marked || []).map((m: any) => m.user_id).filter(Boolean),
        gallery,
        galleryCount: gallery.length,
      });
    }

    if (action === 'events') {
      const events: any[] = Array.isArray(body?.events) ? body.events.slice(0, 60) : [];
      if (!events.length) return json({ error: 'No events' }, 400);

      const needMatch = events.some((e) => !e?.userId && Array.isArray(e?.descriptor));
      const gallery = needMatch ? await buildGallery(admin, device as Device) : [];
      const cutoffMinutes = await getCutoffMinutes(admin);
      const results: any[] = [];

      for (const ev of events) {
        const iso = typeof ev?.capturedAt === 'string' ? ev.capturedAt : new Date().toISOString();
        let userId: string | null = typeof ev?.userId === 'string' ? ev.userId : null;
        let name: string = typeof ev?.name === 'string' ? ev.name : '';
        let confidence = Number(ev?.confidence);
        if (!Number.isFinite(confidence)) confidence = 0;

        if (!userId) {
          const desc = Array.isArray(ev?.descriptor) ? ev.descriptor.map(Number) : null;
          if (!desc) { results.push({ clientId: ev?.clientId, recognized: false, reason: 'no_payload' }); continue; }
          const m = matchDescriptor(desc, gallery);
          if (!m.recognized) { results.push({ clientId: ev?.clientId, recognized: false, reason: m.reason }); continue; }
          userId = m.entry.user_id;
          name = m.entry.name;
          confidence = m.confidence;
        }

        if (confidence && confidence < MIN_CONFIDENCE) {
          results.push({ clientId: ev?.clientId, recognized: false, reason: 'low_confidence', confidence });
          continue;
        }

        const day = dayKeyInTz(iso);
        const { data: existing } = await admin
          .from('attendance_records')
          .select('id, status')
          .eq('user_id', userId)
          .eq('date', day)
          .in('status', ['present', 'late'])
          .limit(1).maybeSingle();
        if (existing) {
          results.push({ clientId: ev?.clientId, recognized: true, userId, name, alreadyMarked: true, status: existing.status });
          continue;
        }

        if (!name) {
          const { data: p } = await admin.from('profiles')
            .select('full_name, display_name').eq('user_id', userId).maybeSingle();
          name = p?.full_name || p?.display_name || 'Unknown';
        }

        const status = minutesInTz(iso) > cutoffMinutes ? 'late' : 'present';
        const imageUrl = ev?.snapshotBase64 ? await uploadSnapshot(admin, ev.snapshotBase64, userId) : null;

        const { error: insErr } = await admin.from('attendance_records').insert({
          user_id: userId,
          status,
          method: 'kiosk',
          class: device.class,
          section: device.section,
          category: device.category,
          location: device.location || device.name,
          confidence: confidence || null,
          confidence_score: confidence || null,
          image_url: imageUrl,
          timestamp: iso,
          date: day,
          kiosk_device_id: device.id,
          device_info: { source: 'raspberry-pi-kiosk', device: device.name, agent: body?.agentVersion || null },
          metadata: { name, source: 'raspberry-pi-kiosk', device: device.name },
        });

        if (insErr) {
          results.push({ clientId: ev?.clientId, recognized: true, userId, name, error: insErr.message });
          continue;
        }

        results.push({ clientId: ev?.clientId, recognized: true, userId, name, status, confidence });
        if (ev?.notify !== false) await notifyParent(admin, userId, name, status, iso, device.name);
      }

      return json({
        ok: true,
        summary: {
          total: events.length,
          marked: results.filter((r) => r.status && !r.alreadyMarked).length,
          alreadyMarked: results.filter((r) => r.alreadyMarked).length,
          unrecognized: results.filter((r) => !r.recognized).length,
        },
        results,
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e: any) {
    console.error('kiosk-gateway error', e);
    return json({ error: e?.message || 'Unknown error' }, 500);
  }
});
