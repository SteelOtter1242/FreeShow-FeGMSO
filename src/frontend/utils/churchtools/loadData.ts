type ChurchToolsProviderData = {
    url?: string
    clientId?: string
    clientSecret?: string
    serviceId?: number
    sngFolder?: string
    sngTranslationMethod?: "multiline" | "textboxes"
    calWeeksBack?: number
    calWeeksAhead?: number
}

type ChurchToolsLoadDataOverrides = {
    interactive?: boolean
    importProjectsOnly?: boolean
    requiredScope?: string
    serviceId?: number
    from?: string
    to?: string
}

function trimOrUndefined(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    return trimmed || undefined
}

export function buildChurchToolsLoadData(providerData: ChurchToolsProviderData = {}, overrides: ChurchToolsLoadDataOverrides = {}) {
    return {
        interactive: overrides.interactive ?? false,
        importProjectsOnly: overrides.importProjectsOnly,
        requiredScope: overrides.requiredScope,
        from: overrides.from,
        to: overrides.to,
        serviceId: overrides.serviceId ?? providerData.serviceId ?? undefined,
        sngFolder: trimOrUndefined(providerData.sngFolder),
        sngTranslationMethod: providerData.sngTranslationMethod || undefined,
        calWeeksBack: providerData.calWeeksBack ?? undefined,
        calWeeksAhead: providerData.calWeeksAhead ?? undefined,
        clientId: trimOrUndefined(providerData.clientId),
        clientSecret: providerData.clientSecret || undefined,
        url: trimOrUndefined(providerData.url)
    }
}
