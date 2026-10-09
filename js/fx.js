/*==========================================================
 LATINADVISOR
 FX MODULE
 VERSION 2.0 — FUENTE OFICIAL (RBA) PARA AUD, RESPALDO COMERCIAL
 ----------------------------------------------------------
 Se usa exclusivamente para mostrar un segundo valor (normalmente
 USD) en el PDF de la cotización: es una conversión de
 PRESENTACIÓN, nunca toca los montos ni los totales reales de
 la cotización (esos siguen siendo, y solo siempre serán, los
 que calcula pricing.js en la moneda de la cotización).

 DOS FUENTES (decisión confirmada del cliente, 2026-10-09: el
 estudiante debe poder verificar la tasa en una fuente que
 reconozca como confiable, y ese número debe coincidir con el
 impreso en el PDF):

   1. AUD -> cualquier moneda: tabla oficial "F11.1 Exchange
      Rates" del Reserve Bank of Australia (banco central), vía
      la única ruta pública del Worker de Cloudflare (ver
      worker/ghl-relay.js#handleFxRbaRates — el CSV del RBA no
      trae CORS, así que el navegador no puede leerlo directo).
      El link de verificación del PDF apunta a la página oficial
      del RBA (pdf.js ya la recibe en moneyCtx.fxVerifyUrl) — el
      MISMO request que resolvió el número, nunca un conversor de
      terceros que podría mostrar otro valor.
   2. Cualquier otra moneda base (ej. EUR si algún día se cotiza
      para España): respaldo con open.er-api.com (gratuita, sin
      API key, actualizada a diario) — el RBA solo publica cruces
      de AUD, no sirve para otras monedas base.

 Si AMBAS fuentes fallan, o la moneda no está en su catálogo, se
 retorna null: quien llama debe mostrar un solo valor de moneda en
 vez de romper la generación del PDF.
==========================================================*/

const FX_API_BASE = "https://open.er-api.com/v6/latest";

// Ver ghl.js#GHL_RELAY_BASE_URL — misma base del Worker ya desplegado,
// pero esta ruta específica NO lleva X-App-Secret (es la única pública
// del Worker, a propósito: la abre un estudiante sin autenticar).
const FX_RBA_WORKER_URL = (typeof GHL_RELAY_BASE_URL === "string" && GHL_RELAY_BASE_URL)
    ? `${GHL_RELAY_BASE_URL}/fx/rba-rates`
    : null;

let fxRatesCache = {};

let fxRatesLoadingPromises = {};

/*
    Fuente oficial RBA, vía Worker — ver cabecera de este archivo. Nunca
    lanza: cualquier falla (Worker caído, sin red, CSV con formato
    inesperado) devuelve null para que fetchExchangeRate caiga al
    respaldo comercial en vez de romper el PDF.
*/
async function fetchRbaRates() {

    if (!FX_RBA_WORKER_URL) return null;

    try {

        const response = await fetch(FX_RBA_WORKER_URL);

        if (!response.ok) return null;

        const data = await response.json();

        if (data.result !== "success" || !data.rates) return null;

        // "sourceUrl" ya viene de la respuesta del Worker — es la página
        // oficial de estadísticas del RBA (humana, legible), no un
        // endpoint JSON técnico (ver getFxMeta más abajo).
        data.__sourceUrl = data.sourceUrl || null;

        return data;

    } catch (error) {

        return null;

    }

}

/*
    Respaldo comercial (open.er-api.com) — se usa cuando la moneda base
    no es AUD, o cuando la fuente del RBA falló por cualquier motivo.
*/
async function fetchCommercialRates(fromCurrency) {

    try {

        const url = `${FX_API_BASE}/${encodeURIComponent(fromCurrency)}`;

        const response = await fetch(url);

        if (!response.ok) return null;

        const data = await response.json();

        if (data.result !== "success" || !data.rates) return null;

        // Se guarda la URL EXACTA que se acaba de consultar — mismo
        // principio que fetchRbaRates: el link de verificación del PDF
        // debe ser el MISMO request que resolvió el número.
        data.__sourceUrl = url;

        return data;

    } catch (error) {

        return null;

    }

}

async function fetchExchangeRate(fromCurrency, toCurrency) {

    if (!fromCurrency || !toCurrency) return null;

    if (normalize(fromCurrency) === normalize(toCurrency)) return 1;

    const cacheKey = normalize(fromCurrency);

    if (fxRatesCache[cacheKey]) return resolveRate(fxRatesCache[cacheKey], toCurrency);

    if (!fxRatesLoadingPromises[cacheKey]) {

        fxRatesLoadingPromises[cacheKey] = (async () => {

            try {

                // AUD siempre prefiere la fuente oficial del RBA (decisión
                // confirmada del cliente, 2026-10-09) — el respaldo
                // comercial solo entra si el RBA/Worker falló. Cualquier
                // otra moneda base va directo al respaldo (el RBA no
                // publica cruces que no sean de AUD).
                const data = (cacheKey === "aud" ? await fetchRbaRates() : null)
                    || await fetchCommercialRates(fromCurrency);

                if (data) fxRatesCache[cacheKey] = data;

                return data;

            } finally {

                delete fxRatesLoadingPromises[cacheKey];

            }

        })();

    }

    const data = await fxRatesLoadingPromises[cacheKey];

    return resolveRate(data, toCurrency);

}

function resolveRate(data, toCurrency) {

    if (!data || !data.rates) return null;

    const rate = data.rates[String(toCurrency).toUpperCase()];

    return typeof rate === "number" ? rate : null;

}

/*
    Metadatos de la fuente del tipo de cambio usado para ESTA cotización
    (decisión confirmada del cliente, 2026-10-09: el PDF debe decir de
    dónde sale la tasa de cambio, con un link que el estudiante pueda
    abrir y VER la tasa, coincidiendo siempre con el número impreso).
    "sourceUrl" es la página oficial del RBA (si cacheKey fue "aud" y esa
    fuente respondió) o el request JSON del respaldo comercial — nunca
    una página de mercadeo ni un conversor de terceros que podría mostrar
    un número distinto. Solo lee del caché ya poblado por
    fetchExchangeRate — nunca dispara un fetch aparte — así que hay que
    llamarla DESPUÉS de haber pedido al menos una tasa para "fromCurrency"
    en esta sesión de página. Si ambas fuentes fallaron (o nunca se
    consultó), devuelve null — quien llama debe omitir la nota en vez de
    inventar una fuente.
*/
function getFxMeta(fromCurrency) {

    const cacheKey = normalize(fromCurrency);

    const data = fxRatesCache[cacheKey];

    if (!data) return null;

    return {

        provider: data.provider || null,

        lastUpdateUtc: data.time_last_update_utc || null,

        sourceUrl: data.__sourceUrl || null

    };

}
