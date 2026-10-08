import { get } from "svelte/store"
import { Main } from "../../../types/IPC/Main"
import { sendMain } from "../../IPC/main"
import { contentProviderData, events } from "../../stores"
import { newToast } from "../common"

function normalizeChurchToolsBaseUrl(raw: string): URL | null {
    const trimmed = raw.trim()
    if (!trimmed) return null

    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

    try {
        const url = new URL(withProtocol)
        url.pathname = "/"
        url.search = ""
        url.hash = ""
        return url
    } catch {
        return null
    }
}

function getDomainFromUid(uidValue: string): string {
    const uid = uidValue.trim()
    if (!uid) return ""

    const atIndex = uid.lastIndexOf("@")
    if (atIndex <= 0 || atIndex >= uid.length - 1) return ""

    return uid.slice(atIndex + 1).trim()
}

function getLegacyIdFromUid(uidValue: string): string {
    const uid = uidValue.trim()
    if (!uid) return ""

    const match = uid.match(/^ct-([^@]+)@/i)
    const value = match?.[1]?.trim() || ""
    return /^\d+$/.test(value) ? value : ""
}

function parseIdsFromUid(uidValue: string): { agendaId: string; eventId: string } {
    const uid = uidValue.trim()
    if (!uid) return { agendaId: "", eventId: "" }

    // New format: ct-a{agendaId}-e{eventId}@domain
    const rich = uid.match(/^ct-a([0-9]+)-e([0-9]+)@/i)
    if (rich) {
        return {
            agendaId: rich[1] || "",
            eventId: rich[2] || ""
        }
    }

    // Legacy format: ct-{id}@domain.
    // In observed CT flows, this id behaves as event id for /api/events/{id}/agenda.
    const legacyId = getLegacyIdFromUid(uid)
    if (!legacyId) return { agendaId: "", eventId: "" }

    return { agendaId: "", eventId: legacyId }
}

function toIsoDate(value: string): string {
    const date = new Date(value)
    if (isNaN(date.getTime())) return ""

    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function buildChurchToolsEventUrl(raw: string, uidValue: string, fromValue: string): string {
    const baseUrl = normalizeChurchToolsBaseUrl(raw)
    if (!baseUrl) return ""

    const { agendaId, eventId } = parseIdsFromUid(uidValue)
    const eventDate = toIsoDate(fromValue)

    baseUrl.searchParams.set("q", "churchservice")
    if (eventDate) baseUrl.searchParams.set("date", eventDate)

    // Event-specific deep-link aligned with verified CT behavior:
    // ?q=churchservice&event={eventId}#AgendaView/
    // triggers GET /api/events/{eventId}/agenda and then CT internal setting updates.
    if (agendaId || eventId) {
        if (agendaId) baseUrl.searchParams.set("currentAgenda", agendaId)
        if (eventId) baseUrl.searchParams.set("event", eventId)

        // Critical: keep AgendaView hash root (without id segment).
        baseUrl.hash = "AgendaView/"

        return baseUrl.toString()
    }

    // Without ids, avoid opening a stale previously selected agenda entry.
    // Keep user on date-specific list view instead of misleading agenda detail.
    baseUrl.hash = "ListView/"
    return baseUrl.toString()
}

export function openChurchToolsEvent(eventId: string) {
    const event = get(events)?.[eventId]
    if (!event) return

    if (!event.origin?.startsWith("ct_cal_")) {
        newToast("This calendar event is not from ChurchTools sync")
        return
    }

    const configuredUrl = String(get(contentProviderData)?.churchtools?.url || "").trim()
    const domainFromUid = getDomainFromUid(String(event.id || ""))
    const sourceUrl = configuredUrl || domainFromUid

    if (!sourceUrl) {
        newToast("Could not determine ChurchTools domain for this event")
        return
    }

    const agendaUrl = buildChurchToolsEventUrl(sourceUrl, String(event.id || ""), String(event.from || ""))
    if (!agendaUrl) {
        newToast("Could not build ChurchTools URL")
        return
    }

    sendMain(Main.URL, agendaUrl)
}
