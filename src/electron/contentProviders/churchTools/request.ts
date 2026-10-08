/**
 * WARNING: This file should ONLY be accessed through ChurchToolsProvider.
 * Do not import or use functions from this file directly in other parts of the application.
 * Use ContentProviderRegistry or ChurchToolsProvider instead.
 */

import { uid } from "uid"
import { ToMain } from "../../../types/IPC/ToMain"
import { sendToMain } from "../../IPC/main"
import { httpsRequest } from "../../utils/requests"
import { ctGetAccess } from "./connect"
import { ctFetchProjectEvents, ctImportProjectsFromEvents, resolveProjectImportScope } from "./ctProjectImport"

let msOfficePptConverter: ((inputPath: string) => Promise<any>) | null = null
try {
    // Optional converter module from the dedicated PPT PR.
    // Falls back to the normal import pipeline when unavailable.
    const mod = require("../../output/ppt/msOfficeConverter")
    if (typeof mod?.convertPptFileToSlides === "function") msOfficePptConverter = mod.convertPptFileToSlides
} catch {}

// ── API request ──────────────────────────────────────────────────────────────

function ctGet(domain: string, token: string, endpoint: string, params?: Record<string, string>): Promise<any> {
    return new Promise((resolve) => {
        let path = `/api/${endpoint}`
        if (params && Object.keys(params).length) path += `?${new URLSearchParams(params).toString()}`
        const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" }
        httpsRequest(domain, path, "GET", headers, {}, (err, result) => {
            if (err) {
                if (err.statusCode !== 404) console.warn(`ChurchTools [${endpoint}]:`, err.message)
                return resolve({ __error: { endpoint, statusCode: err.statusCode || 0, message: err.message || "Request failed" } })
            }
            resolve(result)
        })
    })
}

// Song and attachment concerns are extracted into ctSongResolver.ts and ctAttachmentImporter.ts.

// ── Calendar events ────────────────────────────────────────────────────────────

function toICalDateTime(dateStr: string): string {
    const d = new Date(dateStr)
    if (!dateStr || isNaN(d.getTime())) return ""
    return d.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z"
}

function escapeIcal(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
}

function asCtId(value: any): string {
    if (value === undefined || value === null) return ""
    const str = String(value).trim()
    if (!str) return ""
    return /^[0-9]+$/.test(str) ? str : ""
}

function buildCtUid(appt: any, domain: string): string {
    const agendaId =
        asCtId(appt.id) ||
        asCtId(appt.agendaId) ||
        asCtId(appt.base?.agendaId) ||
        asCtId(appt.base?.id)

    const eventId =
        asCtId(appt.event?.id) ||
        asCtId(appt.eventId) ||
        asCtId(appt.base?.event?.id) ||
        asCtId(appt.base?.eventId)

    // New format keeps both identifiers for exact CT deep-linking.
    if (agendaId && eventId) return `ct-a${agendaId}-e${eventId}@${domain}`

    // Backward-compatible format for instances where only one id is exposed.
    const fallbackId = agendaId || eventId || uid(8)
    return `ct-${fallbackId}@${domain}`
}

function buildICalContent(appointments: any[], calName: string, domain: string): string {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FreeShow//ChurchTools//EN", `X-WR-CALNAME:${escapeIcal(calName)}`]
    for (const appt of appointments) {
        const startRaw = appt.startDate ?? appt.base?.startDate ?? ""
        const endRaw   = appt.endDate   ?? appt.base?.endDate   ?? startRaw
        const name     = escapeIcal((appt.base?.title ?? appt.base?.caption ?? appt.title ?? appt.name ?? "").trim())
        const loc      = escapeIcal((appt.base?.location ?? appt.location ?? "").trim())
        const start    = toICalDateTime(startRaw)
        const end      = toICalDateTime(endRaw) || start
        if (!name || !start) continue
        lines.push("BEGIN:VEVENT", `UID:${buildCtUid(appt, domain)}`, `SUMMARY:${name}`, `DTSTART:${start}`, `DTEND:${end}`)
        if (loc) lines.push(`LOCATION:${loc}`)
        lines.push("END:VEVENT")
    }
    lines.push("END:VCALENDAR")
    return lines.join("\r\n")
}

async function ctLoadCalendarEvents(domain: string, token: string, from: string, to: string): Promise<number> {
    let appointments: any[] = []

    // CT requires calendar_ids[] — fetch all calendars first, then build URL with IDs
    const cals = await ctGet(domain, token, "calendars")
    const calList: any[] = cals?.data ?? []
    if (calList.length) {
        const idParams = calList.map((c: any) => `calendar_ids[]=${encodeURIComponent(c.id)}`).join("&")
        const r = await ctGet(domain, token, `calendars/appointments?${idParams}&from=${from}&to=${to}`)
        if (r?.data?.length) appointments = r.data
    }

    // Fallback: per-calendar fetch if combined didn't work
    if (!appointments.length) {
        for (const cal of calList) {
            const r = await ctGet(domain, token, `calendars/${cal.id}/appointments`, { from, to })
            if (r?.data?.length) appointments.push(...r.data)
        }
    }

    if (!appointments.length) return 0

    // Group by calendar so each gets its own color in FreeShow
    const calMap = new Map<string, { name: string; items: any[] }>()
    for (const appt of appointments) {
        const calId   = String(appt.calendar?.id ?? appt.calendarId ?? "ct")
        const calName = appt.calendar?.name ?? "ChurchTools"
        if (!calMap.has(calId)) calMap.set(calId, { name: calName, items: [] })
        calMap.get(calId)!.items.push(appt)
    }

    const calendarData = Array.from(calMap.entries()).map(([calId, { name, items }]) => ({
        content: buildICalContent(items, name, domain),
        name,
        id: `ct_cal_${calId}`
    }))

    sendToMain(ToMain.IMPORT2, { channel: "calendar", data: calendarData as any })
    return appointments.length
}

async function ctSyncCalendarOnly(domain: string, token: string, from: string, to: string): Promise<void> {
    const appointmentCount = await ctLoadCalendarEvents(domain, token, from, to)
    console.info(`[CT-SYNC] calendar sync only imported appointments=${appointmentCount}`)
    if (!appointmentCount) sendToMain(ToMain.TOAST, `ChurchTools: no calendar events found from ${from} to ${to}`)
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function ctLoadServices(serviceId?: number, fromOverride?: string, toOverride?: string, importProjectsOnly = false): Promise<void> {
    const access = ctGetAccess()
    if (!access?.domain || !access?.access_token) {
        console.warn("[CT-SYNC] ctLoadServices aborted: missing domain/token")
        sendToMain(ToMain.TOAST, "ChurchTools sync skipped: missing connection or access token")
        return
    }

    const { domain, access_token: token } = access
    const weeksBack = Math.max(0, access.calWeeksBack ?? 3)
    const weeksAhead = Math.max(0, access.calWeeksAhead ?? 9)
    const computedFromDate = new Date()
    computedFromDate.setUTCDate(computedFromDate.getUTCDate() - weeksBack * 7)
    const computedToDate = new Date()
    computedToDate.setUTCDate(computedToDate.getUTCDate() + weeksAhead * 7)

    const computedFrom = computedFromDate.toISOString().slice(0, 10)
    const computedTo = computedToDate.toISOString().slice(0, 10)
    const from = fromOverride || computedFrom
    const to = toOverride || computedTo

    console.info(`[CT-SYNC] load start serviceId=${serviceId ?? "(all)"} from=${from} to=${to} domain=${domain}`)

    // Default sync path (manual + startup) updates calendar only.
    // Project imports are intentionally restricted to the explicit day-import action.
    if (!importProjectsOnly) {
        await ctSyncCalendarOnly(domain, token, from, to)
        return
    }
    const scope = resolveProjectImportScope(from, to)
    const events = await ctFetchProjectEvents(domain, token, scope, serviceId, ctGet)
    if (!events.length) return

    await ctImportProjectsFromEvents(domain, token, access, events, ctGet, msOfficePptConverter)

    console.info("[CT-SYNC] calendar import skipped (project-only sync)")
}
