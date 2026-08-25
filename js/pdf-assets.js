/*==========================================================
 LATINADVISOR
 PDF ASSETS MODULE
 VERSION 2.0
 ----------------------------------------------------------
 Carga los archivos PDF estáticos que necesita la cotización
 desde assets/img/. Ninguno viene de Google Sheets ni de GHL —
 por eso vive aparte de database.js.

 PORTADA (página 1): un PDF de una sola página POR ASESORA
 (nunca por ciudad ni por Onshore/Offshore — decisión confirmada
 del cliente), nombrado exactamente como en ASESORA_COVER_FILES
 más abajo. Si la asesora asignada al lead no tiene portada
 configurada todavía, fetchAsesoraCoverPdfBytes() retorna null —
 pdf.js arma el documento igual, solo que sin página de portada.

 PLANTILLA (página 2): "pagina-blanca-cotizacion.pdf" ya trae
 el diseño completo. A diferencia de la portada, si esta no se
 puede cargar SÍ debe romper la generación (fetchPage2TemplateBytes
 lanza) — no existe una "cotización sin diseño" razonable.

 PLANTILLA DE PÁGINAS EXTRA (página 3 en adelante): solo se usa
 cuando el contenido no cabe en la página principal. A diferencia
 de la plantilla de la página 2, si "pagina-extra.pdf" no se puede
 cargar NO debe romper la generación — es preferible mostrar el
 desborde sin plantilla (ver pdf.js#mergeFinalPdf) a que el asesor
 se quede sin poder generar ninguna cotización.

 PLANTILLA DEL COMPARATIVO: "comparativo.pdf" trae el diseño de la
 página que lista las opciones de colegio lado a lado (una por
 cada pestaña de la cotización). Igual que la plantilla de la
 página 2, si no se puede cargar SÍ debe romper la generación — no
 existe un comparativo razonable sin ella.
==========================================================*/

const PDF_ASSETS_BASE_PATH = "assets/img";

const PAGE2_TEMPLATE_FILENAME = "pagina-blanca-cotizacion.pdf";

const EXTRA_PAGE_TEMPLATE_FILENAME = "pagina-extra.pdf";

const COMPARATIVO_TEMPLATE_FILENAME = "comparativo.pdf";

/*
    Plantilla de la página 2: ya trae el diseño completo (logo,
    título, acento, cuadros verdes "Estudio por"/"Asesora" y el
    encabezado "Detalles del programa:") — pdf.js solo escribe
    ENCIMA de sus coordenadas, nunca la recrea.
*/

let page2TemplateBytesCache = null;

let page2TemplateLoadingPromise = null;

async function fetchPage2TemplateBytes() {

    if (page2TemplateBytesCache) return page2TemplateBytesCache;

    if (!page2TemplateLoadingPromise) {

        page2TemplateLoadingPromise = (async () => {

            const response = await fetch(`${PDF_ASSETS_BASE_PATH}/${PAGE2_TEMPLATE_FILENAME}`);

            if (!response.ok) throw new Error(`No se pudo cargar la plantilla de cotización (${PAGE2_TEMPLATE_FILENAME}): HTTP ${response.status}`);

            return new Uint8Array(await response.arrayBuffer());

        })();

    }

    page2TemplateBytesCache = await page2TemplateLoadingPromise;

    return page2TemplateBytesCache;

}

let extraPageTemplateBytesCache = null;

let extraPageTemplateLoadingPromise = null;

async function fetchExtraPageTemplateBytes() {

    if (extraPageTemplateBytesCache) return extraPageTemplateBytesCache;

    if (!extraPageTemplateLoadingPromise) {

        extraPageTemplateLoadingPromise = (async () => {

            try {

                const response = await fetch(`${PDF_ASSETS_BASE_PATH}/${EXTRA_PAGE_TEMPLATE_FILENAME}`);

                if (!response.ok) return null;

                return new Uint8Array(await response.arrayBuffer());

            } catch (error) {

                return null;

            }

        })();

    }

    extraPageTemplateBytesCache = await extraPageTemplateLoadingPromise;

    return extraPageTemplateBytesCache;

}

let comparativoTemplateBytesCache = null;

let comparativoTemplateLoadingPromise = null;

async function fetchComparativoTemplateBytes() {

    if (comparativoTemplateBytesCache) return comparativoTemplateBytesCache;

    if (!comparativoTemplateLoadingPromise) {

        comparativoTemplateLoadingPromise = (async () => {

            const response = await fetch(`${PDF_ASSETS_BASE_PATH}/${COMPARATIVO_TEMPLATE_FILENAME}`);

            if (!response.ok) throw new Error(`No se pudo cargar la plantilla del comparativo (${COMPARATIVO_TEMPLATE_FILENAME}): HTTP ${response.status}`);

            return new Uint8Array(await response.arrayBuffer());

        })();

    }

    comparativoTemplateBytesCache = await comparativoTemplateLoadingPromise;

    return comparativoTemplateBytesCache;

}

/*
    PORTADA POR ASESORA — reemplaza la vieja selección por ciudad/
    Onshore-Onshore (decisión confirmada del cliente, ver
    pdf.js#generateQuotationPdfBlob): la portada depende ÚNICAMENTE
    de qué asesora tiene asignado el lead en el CRM (mismo nombre
    que ya resuelve pdf.js#resolveAsesoraName para el cuadro verde
    "Asesora" de la página 2), sin importar ciudad ni tipo de
    aplicación. Los nombres de archivo deben respetarse EXACTOS
    (mayúsculas/minúsculas/espacios), tal cual quedaron en
    assets/img/.
*/

const ASESORA_COVER_FILES = {

    "andrea lotero": "Andrea Lotero.pdf",

    "johanna gravenhorst": "Johanna Gravenhort.pdf",

    "maria becerra": "Maria Becerra.pdf",

    "rosario orejuela": "Rosario orejuela.pdf",

    "sandra orejuela": "sandra orejuela.pdf"

};

function normalizeAsesoraKey(name) {

    return stripAccents(normalize(name));

}

const asesoraCoverPdfBytesCache = {};

async function fetchAsesoraCoverPdfBytes(asesoraName) {

    const filename = ASESORA_COVER_FILES[normalizeAsesoraKey(asesoraName)];

    if (!filename) return null;

    if (Object.prototype.hasOwnProperty.call(asesoraCoverPdfBytesCache, filename)) return asesoraCoverPdfBytesCache[filename];

    try {

        const response = await fetch(`${PDF_ASSETS_BASE_PATH}/${encodeURIComponent(filename)}`);

        if (!response.ok) {

            asesoraCoverPdfBytesCache[filename] = null;

            return null;

        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        asesoraCoverPdfBytesCache[filename] = bytes;

        return bytes;

    } catch (error) {

        asesoraCoverPdfBytesCache[filename] = null;

        return null;

    }

}
