export type CTScopes = "services"

export type CTAuthData = {
    access_token: string
    refresh_token: string
    token_type: "Bearer"
    created_at: number
    expires_in: number
    scope: string
    domain: string
    clientId?: string
    clientSecret?: string
    calWeeksBack?: number
    sngFolder?: string
    sngCategory?: string
    sngEncoding?: "auto" | "utf8" | "latin1"
    sngTranslationMethod?: "multiline" | "textboxes" | "layouts"
    sngVariationFamilies?: ("multiline" | "textboxes" | "single")[]
    calWeeksAhead?: number
} | null
