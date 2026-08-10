import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const resendApiKey = Deno.env.get('RESEND_API_KEY')
const googleMailApiKey = Deno.env.get('GOOGLE_MAIL_API_KEY')
const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')
const whatsappAccessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')
const whatsappPhoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')
const sms77RapidApiKey = Deno.env.get('SMS77_RAPIDAPI_KEY')
const cronSecret = Deno.env.get('CRON_SECRET')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null
  let clean = phone.replace(/[\s\-()]/g, '')
  if (clean.startsWith('+')) clean = clean.slice(1)
  if (/^\d{10}$/.test(clean)) clean = `91${clean}`
  return /^\d{10,15}$/.test(clean) ? clean : null
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/

/** Returns a clean, RFC-valid address or null. Prevents Resend 422 validation_error. */
function normalizeEmail(email?: string | null): string | null {
  if (!email || typeof email !== 'string') return null
  let clean = email.trim()
  // accept "Name <email@example.com>" and extract the address
  const angle = clean.match(/<([^>]+)>/)
  if (angle) clean = angle[1].trim()
  clean = clean.replace(/^mailto:/i, '').toLowerCase()
  return EMAIL_RE.test(clean) ? clean : null
}

const FROM_ADDRESS = Deno.env.get('RESEND_FROM') || 'School Alerts <noreply@presences.dev>'


async function sendEmailWithResendOrConnector(rawPayload: {
  to: string
  subject: string
  html: string
}) {
  const to = normalizeEmail(rawPayload.to)
  if (!to) {
    return { ok: false, error: `Invalid recipient email address: "${rawPayload.to}"` }
  }
  const subject = (rawPayload.subject || '').trim() || 'School Notification'
  const html = (rawPayload.html || '').trim() || '<p>School notification</p>'
  const payload = { to, subject, html }

  const sendViaGmailFallback = async () => {
    if (!lovableApiKey || !googleMailApiKey) {
      return { ok: false, error: 'Gmail fallback not configured' }
    }

    const rawEmail = [
      `To: ${payload.to}`,
      `Subject: ${payload.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      payload.html,
    ].join('\r\n')

    const bytes = new TextEncoder().encode(rawEmail)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const encodedRaw = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const response = await fetch('https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        'X-Connection-Api-Key': googleMailApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encodedRaw }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return { ok: false, error: data?.error?.message || data?.message || 'Gmail fallback failed' }
    }

    return { ok: true, id: data?.id || null }
  }

  if (!resendApiKey) {
    const gmailOnly = await sendViaGmailFallback()
    return gmailOnly.ok
      ? { ok: true, id: gmailOnly.id || null }
      : { ok: false, error: gmailOnly.error || 'Email service not configured' }
  }

  if (resendApiKey.startsWith('re_')) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
      }),
    })

    const responseData = await response.json().catch(() => ({}))
    if (!response.ok) {
      const gmailFallback = await sendViaGmailFallback()
      if (gmailFallback.ok) return { ok: true, id: gmailFallback.id || null }
      return { ok: false, error: `Resend failed: ${responseData?.message || 'Failed to send email'} | Gmail fallback failed: ${gmailFallback.error || 'unknown error'}` }
    }
    return { ok: true, id: responseData?.id || null }
  }

  if (!lovableApiKey) {
    const gmailFallback = await sendViaGmailFallback()
    return gmailFallback.ok
      ? { ok: true, id: gmailFallback.id || null }
      : { ok: false, error: `Connector auth key missing | Gmail fallback failed: ${gmailFallback.error || 'unknown error'}` }
  }

  const response = await fetch('https://connector-gateway.lovable.dev/resend/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lovableApiKey}`,
      'X-Connection-Api-Key': resendApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
    }),
  })

  const responseData = await response.json().catch(() => ({}))
  if (!response.ok) {
    const gmailFallback = await sendViaGmailFallback()
    if (gmailFallback.ok) return { ok: true, id: gmailFallback.id || null }
    return {
      ok: false,
      error: `Resend failed: ${responseData?.error?.message || responseData?.message || 'Failed to send email'} | Gmail fallback failed: ${gmailFallback.error || 'unknown error'}`,
    }
  }

  return { ok: true, id: responseData?.id || null }
}

async function sendWhatsAppMessage(phoneNumber: string, message: string) {
  if (!whatsappAccessToken || !whatsappPhoneNumberId) {
    return { success: false, error: 'WhatsApp API not configured' }
  }

  const formattedPhone = normalizePhone(phoneNumber)
  if (!formattedPhone) return { success: false, error: 'Invalid phone number' }

  try {
    const sendViaGraph = async (payload: Record<string, unknown>) => fetch(`https://graph.facebook.com/v25.0/${whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const textResponse = await sendViaGraph({
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'text',
      text: { body: message },
    })

    const textData = await textResponse.json().catch(() => ({}))
    if (textResponse.ok) {
      return { success: true, messageId: textData?.messages?.[0]?.id ?? null }
    }

    const templateResponse = await sendViaGraph({
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'template',
      template: {
        name: 'hello_world',
        language: { code: 'en_US' },
      },
    })

    const templateData = await templateResponse.json().catch(() => ({}))
    if (!templateResponse.ok) {
      const primaryError = textData?.error?.message || 'WhatsApp text send failed'
      const fallbackError = templateData?.error?.message || 'WhatsApp template send failed'
      return { success: false, error: `${primaryError} | fallback: ${fallbackError}` }
    }

    return { success: true, messageId: templateData?.messages?.[0]?.id ?? null }
  } catch (err: any) {
    return { success: false, error: err?.message || 'WhatsApp send failed' }
  }
}

async function sendSmsMessage(phoneNumber: string, message: string) {
  const formattedPhone = normalizePhone(phoneNumber)
  if (!formattedPhone) return { success: false, provider: 'none', error: 'Invalid phone number' }

  if (sms77RapidApiKey) {
    try {
      const response = await fetch('https://sms77io.p.rapidapi.com/sms', {
        method: 'POST',
        headers: {
          'x-rapidapi-key': sms77RapidApiKey,
          'x-rapidapi-host': 'sms77io.p.rapidapi.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          to: formattedPhone,
          text: message,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false || data?.error) {
        return {
          success: false,
          provider: 'sms77',
          error: data?.error?.message || data?.message || 'SMS77 send failed',
        }
      }

      return {
        success: true,
        provider: 'sms77',
        messageId: data?.id ?? data?.msg_id ?? data?.message_id ?? null,
      }
    } catch (err: any) {
      return { success: false, provider: 'sms77', error: err?.message || 'SMS77 send failed' }
    }
  }

  try {
    const response = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        phone: `+${formattedPhone}`,
        message,
        key: 'textbelt',
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data?.success) {
      return { success: false, provider: 'textbelt', error: data?.error || 'Textbelt send failed' }
    }

    return { success: true, provider: 'textbelt', messageId: data?.textId ?? null }
  } catch (err: any) {
    return { success: false, provider: 'textbelt', error: err?.message || 'Textbelt send failed' }
  }
}

function normalizePayload(raw: any) {
  const student = raw?.student && typeof raw.student === 'object'
    ? {
        id: typeof raw.student.id === 'string' ? raw.student.id : undefined,
        name: typeof raw.student.name === 'string' ? raw.student.name : undefined,
        status: typeof raw.student.status === 'string' ? raw.student.status : undefined,
      }
    : {
        id: typeof raw?.studentId === 'string' ? raw.studentId : undefined,
        name: typeof raw?.studentName === 'string' ? raw.studentName : undefined,
        status: typeof raw?.status === 'string' ? raw.status : 'notification',
      }

  const recipientObject = typeof raw?.recipient === 'object' && raw?.recipient !== null ? raw.recipient : null
  const recipientEmail = typeof raw?.recipient === 'string'
    ? raw.recipient
    : typeof recipientObject?.email === 'string'
      ? recipientObject.email
      : undefined

  const recipientName = typeof recipientObject?.name === 'string'
    ? recipientObject.name
    : typeof raw?.parentName === 'string'
      ? raw.parentName
      : undefined

  const recipientPhone = typeof recipientObject?.phone === 'string'
    ? recipientObject.phone
    : typeof raw?.phoneNumber === 'string'
      ? raw.phoneNumber
      : undefined

  const messageObject = typeof raw?.message === 'object' && raw?.message !== null ? raw.message : null
  const subject = typeof raw?.subject === 'string'
    ? raw.subject
    : typeof messageObject?.subject === 'string'
      ? messageObject.subject
      : `School Notification${student.name ? ` - ${student.name}` : ''}`

  const body = typeof raw?.message === 'string'
    ? raw.message
    : typeof messageObject?.body === 'string'
      ? messageObject.body
      : ''

  return {
    student,
    recipient: {
      email: recipientEmail,
      name: recipientName,
      phone: recipientPhone,
    },
    subject,
    body,
    targetUserId: typeof raw?.targetUserId === 'string' ? raw.targetUserId : undefined,
  }
}

async function resolveParentContact(supabaseClient: any, targetUserId?: string, studentId?: string) {
  const lookupId = targetUserId || studentId
  if (!lookupId) return null

  let { data: profile } = await supabaseClient
    .from('profiles')
    .select('parent_email, parent_name, parent_phone, phone, metadata')
    .eq('user_id', lookupId)
    .maybeSingle()

  if (!profile) {
    const byId = await supabaseClient
      .from('profiles')
      .select('parent_email, parent_name, parent_phone, phone, metadata')
      .eq('id', lookupId)
      .maybeSingle()
    profile = byId.data
  }

  if (!profile && studentId) {
    const fromRecord = await supabaseClient
      .from('attendance_records')
      .select('device_info')
      .eq('user_id', studentId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    const metadata = (fromRecord.data?.device_info as any)?.metadata || {}
    return {
      email: metadata.parent_email || null,
      phone: normalizePhone(metadata.parent_phone || null),
      name: metadata.parent_name || null,
    }
  }

  const metadata = (profile as any)?.metadata || {}
  return {
    email: profile?.parent_email || null,
    phone: normalizePhone(profile?.parent_phone || metadata?.parent_phone || profile?.phone || null),
    name: profile?.parent_name || null,
  }
}

async function storeInAppNotification(
  supabaseClient: any,
  targetUserId: string,
  title: string,
  message: string,
  type = 'attendance',
) {
  const { error } = await supabaseClient.from('notifications').insert({
    user_id: targetUserId,
    title,
    message,
    type,
    read: false,
  })
  return !error
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const cronHeader = req.headers.get('x-cron-secret')
    const isCronCall = !!cronSecret && !!cronHeader && cronHeader === cronSecret

    if (!authHeader && !isCronCall) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    })
    const dbClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

    const { data: { user }, error: authError } = authHeader
      ? await supabaseClient.auth.getUser()
      : { data: { user: null }, error: null }

    if (authHeader && (authError || !user)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!isCronCall) {
      const [{ data: roleData }, { data: teacherData }] = await Promise.all([
        supabaseClient.from('user_roles').select('role').eq('user_id', user!.id).in('role', ['admin', 'principal']).maybeSingle(),
        supabaseClient.from('teacher_permissions').select('id').eq('user_id', user!.id).limit(1),
      ])

      const isAuthorized = roleData || (teacherData && teacherData.length > 0)
      if (!isAuthorized) {
        return new Response(JSON.stringify({ error: 'Forbidden - Admin, Principal, or Teacher access required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const rawBody = await req.json()
    const payload = normalizePayload(rawBody)
    if (!payload.body?.trim()) {
      return new Response(JSON.stringify({ error: 'Message body is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const parentContact = await resolveParentContact(
      dbClient,
      payload.targetUserId,
      payload.student.id,
    )

    const recipientEmail = normalizeEmail(payload.recipient.email) || normalizeEmail(parentContact?.email) || null
    const recipientPhone = normalizePhone(payload.recipient.phone || parentContact?.phone || null)
    const recipientName = payload.recipient.name || parentContact?.name || 'Parent/Guardian'

    let emailSent = false
    let emailError: string | null = null
    let emailId: string | null = null
    if (recipientEmail) {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(payload.subject)}</title></head>
        <body style="font-family:Arial,sans-serif;line-height:1.6;margin:0;padding:0;background:#f4f4f5;">
          <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px;"><tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;">
              <tr><td style="padding:20px 24px;background:#1d4ed8;color:#fff;font-size:20px;font-weight:700;">School Notification</td></tr>
              <tr><td style="padding:24px;white-space:pre-line;color:#111827;">
                <p style="margin-top:0;">Dear ${escapeHtml(recipientName)},</p>
                ${escapeHtml(payload.body)}
              </td></tr>
            </table>
          </td></tr></table>
        </body>
        </html>`

      const sendResult = await sendEmailWithResendOrConnector({
        to: recipientEmail,
        subject: payload.subject,
        html: htmlContent,
      })

      if (sendResult.ok) {
        emailSent = true
        emailId = sendResult.id
      } else {
        emailError = sendResult.error || 'Email failed'
      }
    }

    let whatsappSent = false
    let whatsappError: string | null = null
    let smsSent = false
    let smsError: string | null = null
    let smsProvider: string | null = null
    if (recipientPhone) {
      const whatsappBody = `${payload.subject}\n\n${payload.body}`
      const waResult = await sendWhatsAppMessage(recipientPhone, whatsappBody)
      whatsappSent = waResult.success
      whatsappError = waResult.success ? null : waResult.error || 'WhatsApp failed'

      const smsResult = await sendSmsMessage(recipientPhone, payload.body)
      smsSent = smsResult.success
      smsError = smsResult.success ? null : smsResult.error || 'SMS failed'
      smsProvider = smsResult.provider || null

      await dbClient.from('notification_log').insert({
        recipient_phone: recipientPhone,
        recipient_id: payload.targetUserId || payload.student.id || null,
        message_content: whatsappBody,
        notification_type: 'whatsapp',
        language: 'en',
        status: waResult.success ? 'sent' : 'failed',
        gateway_response: waResult as any,
      })

      await dbClient.from('notification_log').insert({
        recipient_phone: recipientPhone,
        recipient_id: payload.targetUserId || payload.student.id || null,
        message_content: payload.body,
        notification_type: 'sms',
        language: 'en',
        status: smsResult.success ? 'sent' : 'failed',
        gateway_response: smsResult as any,
      })
    }

    let inAppNotification = false
    const notificationTargetUserId = payload.targetUserId || payload.student.id
    if (notificationTargetUserId) {
      inAppNotification = await storeInAppNotification(
        supabaseClient,
        notificationTargetUserId,
        payload.subject,
        payload.body,
        payload.student.status === 'notification' ? 'info' : 'attendance',
      )
    }

    await supabaseClient.from('notifications').insert({
      user_id: user?.id || payload.targetUserId || payload.student.id || null,
      title: `Notification dispatch${payload.student.name ? ` • ${payload.student.name}` : ''}`,
      message: [
        emailSent ? 'Email: sent' : emailError ? `Email: ${emailError}` : 'Email: skipped',
        whatsappSent ? 'WhatsApp: sent' : whatsappError ? `WhatsApp: ${whatsappError}` : 'WhatsApp: skipped',
        smsSent ? `SMS (${smsProvider || 'provider'}): sent` : smsError ? `SMS: ${smsError}` : 'SMS: skipped',
        inAppNotification ? 'In-app: sent' : 'In-app: skipped',
      ].join(' | '),
      type: 'notification_dispatch',
    })

    const success = emailSent || whatsappSent || smsSent || inAppNotification
    return new Response(JSON.stringify({
      success,
      message: success ? 'Notification processed' : 'No channel delivered',
      channels: {
        email: { sent: emailSent, id: emailId, error: emailError },
        whatsapp: { sent: whatsappSent, error: whatsappError },
        sms: { sent: smsSent, provider: smsProvider, error: smsError },
        inApp: { sent: inAppNotification },
      },
    }), {
      status: success ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error: any) {
    return new Response(JSON.stringify({
      error: 'Failed to send notification',
      details: error?.message || 'Unknown error',
      support_id: crypto.randomUUID(),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})