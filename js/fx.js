/*==========================================================
 LATINADVISOR
 FX MODULE
 VERSION 2.1 — FUENTE OFICIAL (RBA) PARA AUD, RESPALDO COMERCIAL
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

   1. AUD -> una moneda que el RBA SÍ publique (ver RBA_CURRENCIES
      más abajo — hoy USD, EUR, GBP, NZD, CAD, CNY, JPY y poco más,
      NUNCA COP): tabla oficial "F11.1 Exchange Rates" del Reserve
      Bank of Australia (banco central), vía la única ruta pública
      del Worker de Cloudflare (ver
      worker/ghl-relay.js#handleFxRbaRates — el CSV del RBA no trae
      CORS, así que el navegador no puede leerlo directo). El link
      de verificación del PDF apunta a la página oficial del RBA
      (pdf.js ya la recibe en moneyCtx.fxVerifyUrl) — el MISMO
      request que resolvió el número, nunca un conversor de
      terceros que podría mostrar otro valor.
   2. Cualquier otro par (AUD -> una moneda que el RBA no publique,
      ej. COP; o cualquier otra moneda base, ej. EUR si algún día
      se cotiza para España): respaldo con open.er-api.com (gratuita,
      sin API key, actualizada a diario).

 IMPORTANTE (decisión confirmada del cliente, 2026-10-09, bug real
 encontrado): la fuente se decide POR PAR DE MONEDAS, no solo por
 la moneda base — antes se revisaba únicamente si el RBA respondía
 (found:true), sin confirmar que trajera la moneda destino
 realmente pedida. Con AUD/COP eso hacía que el cálculo se quedara
 pegado al RBA (que no tiene COP) y nunca cayera al respaldo
 comercial, Y ADEMÁS la nota del PDF igual enlazaba a la página del
 RBA como si ahí estuviera el dato — el estudiante hubiera abierto
 ese link y no habría encontrado ningún COP. Por eso el caché ahora
 es por PAR (ej. "aud:usd" vs "aud:cop"), nunca solo por moneda base.

 Si AMBAS fuentes fallan, o la moneda no está en ningún catálogo, se
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

// Caché del CSV crudo del RBA (una sola fila de monedas, independiente de
// cuál par se esté resolviendo) — separado del caché por par de abajo,
// para no volver a pedirlo si ya se consultó una vez en esta página.
let rbaRatesCache = null;

let rbaRatesLoadingPromise = null;

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

    if (rbaRatesCache) return rbaRatesCache;

    if (!rbaRatesLoadingPromise) {

        rbaRatesLoadingPromise = (async () => {

            try {

                const response = await fetch(FX_RBA_WORKER_URL);

                if (!response.ok) return null;

                const data = await response.json();

                if (data.result !== "success" || !data.rates) return null;

                // "sourceUrl" ya viene de la respuesta del Worker — es la
                // página oficial de estadísticas del RBA (humana,
                // legible), no un endpoint JSON técnico (ver getFxMeta).
                data.__sourceUrl = data.sourceUrl || null;

                rbaRatesCache = data;

                return data;

            } catch (error) {

                return null;

            } finally {

                rbaRatesLoadingPromise = null;

            }

        })();

    }

    return rbaRatesLoadingPromise;

}

/*
    Respaldo comercial (open.er-api.com) — se usa cuando el RBA no
    publica la moneda destino pedida, cuando la moneda base no es AUD, o
    cuando la fuente del RBA falló por cualquier motivo.
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

function hasRate(data, toCurrency) {

    return !!(data && data.rates && typeof data.rates[String(toCurrency).toUpperCase()] === "number");

}

async function fetchExchangeRate(fromCurrency, toCurrency) {

    if (!fromCurrency || !toCurrency) return null;

    if (normalize(fromCurrency) === normalize(toCurrency)) return 1;

    // Caché por PAR (no solo por moneda base) — ver cabecera del archivo.
    const cacheKey = `${normalize(fromCurrency)}:${normalize(toCurrency)}`;

    if (fxRatesCache[cacheKey]) return resolveRate(fxRatesCache[cacheKey], toCurrency);

    if (!fxRatesLoadingPromises[cacheKey]) {

        fxRatesLoadingPromises[cacheKey] = (async () => {

            try {

                let data = null;

                // AUD prefiere la fuente oficial del RBA (decisión
                // confirmada del cliente, 2026-10-09) — pero SOLO si el
                // RBA de verdad trae la moneda destino pedida (ver
                // hasRate); si no (ej. COP), cae al respaldo comercial en
                // vez de quedarse con datos oficiales que no cubren esa
                // moneda.
                if (normalize(fromCurrency) === "aud") {

                    const rbaData = await fetchRbaRates();

                    if (hasRate(rbaData, toCurrency)) data = rbaData;

                }

                if (!data) data = await fetchCommercialRates(fromCurrency);

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
    Recibe el MISMO par (fromCurrency, toCurrency) que se le pidió a
    fetchExchangeRate — el caché ahora es por par, así que una fuente
    distinta por cada moneda destino es posible y correcto (ej. AUD/USD
    por RBA, AUD/COP por el respaldo comercial, dentro de la misma
    cotización). "sourceUrl" es la página oficial del RBA (si esa fuente
    respondió para este par) o el request JSON del respaldo comercial —
    nunca una página de mercadeo ni un conversor de terceros que podría
    mostrar un número distinto. Solo lee del caché ya poblado por
    fetchExchangeRate — nunca dispara un fetch aparte — así que hay que
    llamarla DESPUÉS de haber pedido esa tasa en esta sesión de página. Si
    la fuente falló (o nunca se consultó), devuelve null — quien llama
    debe omitir la nota en vez de inventar una fuente.
*/
function getFxMeta(fromCurrency, toCurrency) {

    const cacheKey = `${normalize(fromCurrency)}:${normalize(toCurrency)}`;

    const data = fxRatesCache[cacheKey];

    if (!data) return null;

    return {

        provider: data.provider || null,

        lastUpdateUtc: data.time_last_update_utc || null,

        sourceUrl: data.__sourceUrl || null

    };

}
