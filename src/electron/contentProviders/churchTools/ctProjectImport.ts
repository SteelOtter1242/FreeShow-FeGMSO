import { uid } from "uid"
import { ToMain } from "../../../types/IPC/ToMain"
import { sendToMain } from "../../IPC/main"
import { appendAttachmentImports, fetchEventAttachments } from "./ctAttachmentImporter"
import { buildHeaderShow, buildSngIndex, processAgendaItem } from "./ctSongResolver"

type CTGetFn = (domain: string, token: string, endpoint: string, params?: Record<string, string>) => Promise<any>

type CTAccess = {
    sngFolder?: string
}

export type CTProjectImportScope = {
    from: string
    to: string
    isSingleDayImport: boolean
    selectedDay?: string
}

function getEventDateKey(event: any): string {
    const startDate: string = event?.attributes?.startDate ?? event?.startDate ?? ""
    const explicitDate = startDate.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
    if (explicitDate) return explicitDate
    const parsed = new Date(startDate)
    if (isNaN(parsed.getTime())) return ""
    const pad = (n: number) => n.toString().padStart(2, "0")
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

export function resolveProjectImportScope(fromOverride?: string, toOverride?: string): CTProjectImportScope {
    const from = fromOverride || ""
    const to = toOverride || ""
    const isSingleDayImport = !!fromOverride && !!toOverride && fromOverride === toOverride
    return { from, to, isSingleDayImport, selectedDay: isSingleDayImport ? fromOverride : undefined }
}

export async function ctFetchProjectEvents(domain: string, token: string, scope: CTProjectImportScope, serviceId: number | undefined, ctGet: CTGetFn): Promise<any[]> {
    const params: Record<string, string> = { from: scope.from, to: scope.to }
    if (serviceId) params.serviceId = String(serviceId)

    let eventsResult = await ctGet(domain, token, "events", params)
    let events: any[] = eventsResult?.data ?? []
    console.info(`[CT-SYNC] events fetched count=${events.length}`)

    if (eventsResult?.__error?.statusCode === 403) {
        const msg = "ChurchTools sync blocked (403): your OAuth client/account can authenticate but is not allowed to read events/agenda API data."
        console.warn(`[CT-SYNC] ${msg}`)
        sendToMain(ToMain.TOAST, msg)
        return []
    }

    // Date-scoped import can miss services around midnight/timezone boundaries.
    // Retry once with a wider range before giving up.
    if (!events.length && scope.from && scope.to) {
        const fallbackFromDate = new Date(`${scope.from}T00:00:00Z`)
        const fallbackToDate = new Date(`${scope.to}T00:00:00Z`)
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
        if (scope.from || scope.to) {
            sendToMain(ToMain.TOAST, `ChurchTools: no services found from ${scope.from} to ${scope.to}`)
        } else {
            sendToMain(ToMain.TOAST, "ChurchTools: no services found")
        }
        return []
    }

    if (scope.isSingleDayImport && scope.selectedDay) {
        const beforeCount = events.length
        events = events.filter((event: any) => getEventDateKey(event) === scope.selectedDay)
        console.info(`[CT-SYNC] single-day filter day=${scope.selectedDay} kept=${events.length}/${beforeCount}`)
        if (!events.length) {
            sendToMain(ToMain.TOAST, `ChurchTools: no services found on ${scope.selectedDay}`)
            return []
        }
    }

    return events
}

export async function ctImportProjectsFromEvents(
    domain: string,
    token: string,
    access: CTAccess,
    events: any[],
    ctGet: CTGetFn,
    msOfficePptConverter: ((inputPath: string) => Promise<any>) | null
): Promise<void> {
    const now = new Date()
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

                // CT renders "Eventstart" when isBeforeEvent transitions from true -> false
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
}