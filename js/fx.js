/*==========================================================
 LATINADVISOR
 FX MODULE
 VERSION 1.0
 ----------------------------------------------------------
 Único módulo que habla con la API pública de tasas de cambio
 (open.er-api.com — gratuita, sin API key, actualizada a
 diario). Se usa exclusivamente para mostrar un segundo valor
 en USD en el PDF de la cotización: es una conversión de
 PRESENTACIÓN, nunca toca los montos ni los totales reales de
 la cotización (esos siguen siendo, y solo siempre serán, los
 que calcula pricing.js en la moneda de la cotización).

 Si la API falla, o la moneda de la cotización no está en su
 catálogo, se retorna null: quien llama debe mostrar un solo
 valor de moneda en vez de romper la generación del PDF.
==========================================================*/

const FX_API_BASE = "https://open.er-api.com/v6/latest";

let fxRatesCache = {};

let fxRatesLoadingPromises = {};

async function fetchExchangeRate(fromCurrency, toCurrency) {

    if (!fromCurrency || !toCurrency) return null;

    if (normalize(fromCurrency) === normalize(toCurrency)) return 1;

    const cacheKey = normalize(fromCurrency);

    if (fxRatesCache[cacheKey]) return resolveRate(fxRatesCache[cacheKey], toCurrency);

    if (!fxRatesLoadingPromises[cacheKey]) {

        fxRatesLoadingPromises[cacheKey] = (async () => {

            try {

                const response = await fetch(`${FX_API_BASE}/${encodeURIComponent(fromCurrency)}`);

                if (!response.ok) return null;

                const data = await response.json();

                if (data.result !== "success" || !data.rates) return null;

                fxRatesCache[cacheKey] = data.rates;

                return data.rates;

            } catch (error) {

                return null;

            } finally {

                delete fxRatesLoadingPromises[cacheKey];

            }

        })();

    }

    const rates = await fxRatesLoadingPromises[cacheKey];

    return resolveRate(rates, toCurrency);

}

function resolveRate(rates, toCurrency) {

    if (!rates) return null;

    const rate = rates[String(toCurrency).toUpperCase()];

    return typeof rate === "number" ? rate : null;

}
