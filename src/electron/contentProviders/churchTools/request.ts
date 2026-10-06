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
import { appendAttachmentImports, fetchEventAttachments } from "./ctAttachmentImporter"
import { buildHeaderShow, buildSngIndex, processAgendaItem } from "./ctSongResolver"

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
        lines.push("BEGIN:VEVENT", `UID:ct-${appt.id ?? uid(8)}@${domain}`, `SUMMARY:${name}`, `DTSTART:${start}`, `DTEND:${end}`)
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

// ── Main export ──────────────────────────────────────────────────────────────

export async function ctLoadServices(serviceId?: number, fromOverride?: string, toOverride?: string, importProjectsOnly = false): Promise<void> {
    const access = ctGetAccess()
    if (!access?.domain || !access?.access_token) {
        console.warn("[CT-SYNC] ctLoadServices aborted: missing domain/token")
        sendToMain(ToMain.TOAST, "ChurchTools sync skipped: missing connection or access token")
        return
    }

    const { domain, access_token: token } = access
    const now = new Date()
    const weeksBack = Math.max(0, access.calWeeksBack ?? 3)
    const weeksAhead = Math.max(0, access.calWeeksAhead ?? 9)
    const computedFromDate = new Date(now)
    computedFromDate.setUTCDate(computedFromDate.getUTCDate() - weeksBack * 7)
    const computedToDate = new Date(now)
    computedToDate.setUTCDate(computedToDate.getUTCDate() + weeksAhead * 7)

    const computedFrom = computedFromDate.toISOString().slice(0, 10)
    const computedTo = computedToDate.toISOString().slice(0, 10)
    const from = fromOverride || computedFrom
    const to = toOverride || computedTo

    console.info(`[CT-SYNC] load start serviceId=${serviceId ?? "(all)"} from=${from} to=${to} domain=${domain}`)

    // Default sync path (manual + startup) updates calendar only.
    // Project imports are intentionally restricted to the explicit day-import action.
    if (!importProjectsOnly) {
        const appointmentCount = await ctLoadCalendarEvents(domain, token, from, to)
        console.info(`[CT-SYNC] calendar sync only imported appointments=${appointmentCount}`)
        if (!appointmentCount) sendToMain(ToMain.TOAST, `ChurchTools: no calendar events found from ${from} to ${to}`)
        return
    }

    const params: Record<string, string> = { from, to }
    if (serviceId) params.serviceId = String(serviceId)

    let eventsResult = await ctGet(domain, token, "events", params)
    let events: any[] = eventsResult?.data ?? []
    console.info(`[CT-SYNC] events fetched count=${events.length}`)

    if (eventsResult?.__error?.statusCode === 403) {
        const msg = "ChurchTools sync blocked (403): your OAuth client/account can authenticate but is not allowed to read events/agenda API data."
        console.warn(`[CT-SYNC] ${msg}`)
        sendToMain(ToMain.TOAST, msg)
        return
    }

    // Date-scoped sync can miss services around midnight/timezone boundaries.
    // Retry once with a wider range before giving up.
    if (!events.length && (fromOverride || toOverride)) {
        const fallbackFromDate = new Date(`${from}T00:00:00Z`)
        const fallbackToDate = new Date(`${to}T00:00:00Z`)
        fallbackFromDate.setDate(fallbackFromDate.getDate() - 7)
        fallbackToDate.setDate(fallbackToDate.getDate() + 7)
        const fallbackFrom = fallbackFromDate.toISOString().slice(0, 10)
        const fallbackTo = fallbackToDate.toISOString().slice(0, 10)
        const fallbackParams: Record<string, string> = { ...params, from: fallbackFrom, to: fallbackTo }
        eventsResult = await ctGet(domain, token, "events", fallbackParams)
        events = eventsResult?.data ?? []
        console.info(`[CT-SYNC] fallback window used from=${fallbackFrom} to=${fallbackTo} count=${events.length}`)
        if (events.length) sendToMain(ToMain.TOAST, `ChurchTools: no exact date match; synced from ${fallbackFrom} to ${fallbackTo}`)
    }

    if (!events.length) {
        if (fromOverride || toOverride) {
            sendToMain(ToMain.TOAST, `ChurchTools: no services found from ${from} to ${to}`)
        } else {
            sendToMain(ToMain.TOAST, `No ChurchTools services found in the default sync window (${weeksBack} weeks back, ${weeksAhead} weeks ahead)`)
        }
        return
    }

    sendToMain(ToMain.TOAST, `Loading ${events.length} service(s) from ChurchTools…`)

    const sngIndex = access.sngFolder ? await buildSngIndex(access.sngFolder, (message) => sendToMain(ToMain.ALERT, message)) : undefined
    const translationMethod: "multiline" | "textboxes" = "textboxes"
    const pad = (n: number) => n.toString().padStart(2, "0")

    const projects: any[] = []
    const shows: any[] = []

    await Promise.all(
        events.map(async (event: any) => {
            const eventId: number = event.id
            const eventName: string = event.attributes?.name ?? event.name ?? `Service ${eventId}`
            const startDate: string = event.attributes?.startDate ?? event.startDate ?? now.toISOString()
            const timestamp = new Date(startDate).getTime() || Date.now()
            const d = new Date(startDate)
            const dateLabel = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${pad(d.getHours())}.${pad(d.getMinutes())}`
            const projectName = `${dateLabel} ${eventName}`

            const agendaResult = await ctGet(domain, token, `events/${eventId}/agenda`, { include: "songs" })
            const rawItems: any[] = agendaResult?.data?.attributes?.items ?? agendaResult?.data?.items ?? []
            console.info(`[CT-SYNC] event ${eventId} \"${eventName}\" agendaItems=${rawItems.length}`)

            const sortedItems = [...rawItems].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

            const projectItems: any[] = []
            let seenBeforeEvent = false
            let eventStartInserted = false

            for (const item of sortedItems) {
                // CT section headers become FreeShow project dividers (no show created)
                if (item.type === "header" && item.title) {
                    projectItems.push({ type: "section", id: uid(5), name: item.title, scheduleLength: 0 })
                    continue
                }

                // CT renders "Eventstart" when isBeforeEvent transitions from true → false
                if (item.isBeforeEvent === true) seenBeforeEvent = true
                if (seenBeforeEvent && !eventStartInserted && item.isBeforeEvent !== true && item.type !== "header") {
                    projectItems.push({ type: "section", id: uid(5), name: "Eventstart", scheduleLength: 0 })
                    eventStartInserted = true
                }
                let result: Awaited<ReturnType<typeof processAgendaItem>> | null = null
                try {
                    result = await processAgendaItem(domain, token, item, ctGet, sngIndex, dateLabel, translationMethod)
                } catch (err: any) {
                    console.warn(`ChurchTools: error on item "${item.title}": ${err?.message ?? err}`)
                }
                if (!result) continue
                shows.push({ id: result.showId, ...result.show })
                projectItems.push({ type: "show", id: result.showId, scheduleLength: item.duration ?? 0 })
            }

            // eventFiles is already in the flat event object; fallback to detail fetch if absent
            let rawEventFiles: any[] = event.eventFiles ?? event.attributes?.eventFiles ?? []
            if (!rawEventFiles.length) {
                const detail = await ctGet(domain, token, `events/${eventId}`, { include: "eventFiles" })
                rawEventFiles = detail?.data?.eventFiles ?? detail?.data?.attributes?.eventFiles ?? []
            }
            const attachments = await fetchEventAttachments(domain, token, eventId, rawEventFiles)
            if (attachments.length) console.info(`[CT-SYNC] event ${eventId} attachmentsImported=${attachments.length}`)
            // Append attachments: videos as playable shows, PPTX/PDF auto-converted to slides
            const attachmentData = await appendAttachmentImports(attachments, dateLabel, buildHeaderShow, msOfficePptConverter)
            shows.push(...attachmentData.shows)
            projectItems.push(...attachmentData.projectItems)

            if (!projectItems.length) {
                const infoNote = [
                    "No agenda items or supported attachments were imported for this service.",
                    "This can happen when the service has no agenda data or your API account lacks required permissions.",
                    `Event ID: ${eventId}`
                ].join("\n")
                const { showId, show } = buildHeaderShow(`ChurchTools: empty service (${eventName})`, infoNote, dateLabel)
                shows.push({ id: showId, ...show })
                projectItems.push({ type: "show", id: showId, scheduleLength: 0 })
            }

            if (projectItems.length) {
                projects.push({
                    id: String(eventId),
                    name: projectName,
                    scheduledTo: timestamp,
                    created: timestamp,
                    folderId: "",
                    folderName: "",
                    items: projectItems
                })
                console.info(`[CT-SYNC] event ${eventId} projectItems=${projectItems.length}`)
            }
        })
    )

    if (!projects.length) {
        sendToMain(ToMain.TOAST, `ChurchTools: ${events.length} service(s) found, but no importable project items were created`)
        return
    }

    const sngSummary = sngIndex ? `sng:${sngIndex.byTitle.size}t/${sngIndex.byCcli.size}c` : "sng:none"
    const eventKeys = Object.keys(events[0]?.attributes ?? events[0] ?? {}).slice(0, 8).join(",")
    console.info(`[CT-SYNC] finished projects=${projects.length} shows=${shows.length} ${sngSummary}`)
    sendToMain(ToMain.TOAST, `CT: ${projects.length} services | ${sngSummary} | evKeys:${eventKeys}`)
    sendToMain(ToMain.PROVIDER_PROJECTS, { providerId: "churchtools", categoryName: "ChurchTools", shows, projects })

    console.info("[CT-SYNC] calendar import skipped (project-only sync)")
}
