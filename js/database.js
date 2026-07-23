/*==========================================================
 LATINADVISOR
 DATABASE MODULE
 VERSION 2.0 — CONEXIÓN REAL A GOOGLE SHEETS
 ----------------------------------------------------------
 Este es el ÚNICO módulo que habla con Google Sheets. Ningún
 otro módulo (courses.js, pricing.js, services.js) hace un
 fetch() a Sheets directamente: todos consumen las funciones
 públicas de este archivo.

 TRANSPORTE
 ----------------------------------------------------------
 Se usa el endpoint público "gviz" de Google Sheets
 (…/gviz/tq?tqx=out:json&gid=X), que retorna JSON sin
 necesidad de API key ni backend propio, siempre que el
 documento esté compartido como "Cualquier persona con el
 enlace: Lector". Es de solo lectura — esta app nunca escribe
 en el Sheet, lo cual es intencional: el Sheet es la fuente de
 verdad, la app solo la consulta.

 ESTRATEGIA DE CACHÉ (decisión explicada)
 ----------------------------------------------------------
 Las 8 hojas juntas pesan unos pocos KB (decenas de filas en
 total hoy). Con ese volumen:

   - Consultar Sheets en cada paso de la cascada (Colegio->
     Ciudad->Tipo->Subtipo->Programa) sería lento e
     innecesario: el asesor vería un pequeño delay en cada
     select, siete veces por cotización.
   - Un caché parcial (por hoja, con TTLs distintos) agrega
     complejidad que esta escala de datos no justifica.

 Por eso: PRECARGA INICIAL + CACHÉ TOTAL EN MEMORIA por
 sesión de página. Las 8 hojas se piden UNA sola vez, en
 paralelo (Promise.all), la primera vez que algún módulo pide
 un dato; de ahí en adelante todo se resuelve desde memoria,
 sin más peticiones HTTP. Si el asesor sabe que alguien acaba
 de editar el Sheet, puede forzar un refresco con
 refreshDatabaseCache() sin recargar la página.

 Cuando el catálogo crezca a cientos/miles de filas, esta
 estrategia debe revisarse (paginar, o mover a un backend con
 su propio caché) — pero hoy sería sobre-ingeniería.

 CALIDAD DE DATOS (hallazgos y cómo se manejan)
 ----------------------------------------------------------
 - Los encabezados de columnas en el Sheet real tienen
   espacios finales inconsistentes (ej. "Duración ", "Total ",
   "Promoción ", "Tipo de curso "). Se normalizan (trim) al
   convertir cada hoja a objetos, así el resto del código
   nunca tiene que lidiar con ese detalle.
 - Los valores de "Tipo Curso" en la hoja no siempre respetan
   mayúsculas (ej. "Elicos" en vez de "ELICOS"). Toda
   comparación de texto en este archivo es case-insensitive
   (ver normalize()) y los tipos se normalizan siempre a
   MAYÚSCULAS antes de exponerse a la UI.
 - La hoja "Cursos" trae columnas de Promoción y Total ya
   calculadas manualmente. Por decisión del cliente, la
   columna "Promoción" de "Cursos" tiene PRIORIDAD cuando está
   presente (incluso si es 0); la hoja "Promociones" solo se
   usa como respaldo cuando esa celda está vacía. El total
   nunca se lee de la hoja: siempre se recalcula en pricing.js
   a partir de Valor semana × Duración + Matrícula + Materiales,
   para no depender de una celda que podría quedar desactualizada.
==========================================================*/



/*==========================================================
 CONFIGURACIÓN DEL DOCUMENTO
==========================================================*/

const GOOGLE_SHEET_ID = "1r6JiwRYu7vC8a74pFdasIurYtvfS1aRf6BUFd3VhEN0";

const SHEET_TABS = {

    COLEGIOS: 26646700,

    CURSOS: 750586938,

    VISAS: 0,

    SEGUROS: 170683758,

    COSTOS_FIJOS: 1319196093,

    SERVICIOS_OPCIONALES: 1541131390,

    PROMOCIONES: 909448251,

    PARAMETROS: 916827119

};

/*
    Jerarquía usada cuando una cotización combina varios tipos
    de curso: la visa se cobra UNA sola vez, con el tipo de
    mayor jerarquía presente (decisión confirmada por el
    cliente — así funciona una visa de estudiante real para un
    paquete combinado).
*/

const COURSE_TYPE_PRIORITY = ["HE", "VET", "ELICOS"];



/*==========================================================
 UTILIDADES DE TEXTO
==========================================================*/

function normalize(value) {

    return String(value == null ? "" : value).trim().toLowerCase();

}

function normalizeCourseType(rawType) {

    const value = normalize(rawType);

    if (value === "elicos") return "ELICOS";

    if (value === "vet") return "VET";

    if (value === "he") return "HE";

    return rawType ? String(rawType).trim().toUpperCase() : "";

}

const ACCENT_MAP = { "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u" };

function stripAccents(text) {

    return text.replace(/[áéíóúñü]/g, char => ACCENT_MAP[char] || char);

}

function slugify(text) {

    return stripAccents(String(text || "").trim().toLowerCase())

        .replace(/[^a-z0-9]+/g, "-")

        .replace(/(^-|-$)/g, "");

}



/*==========================================================
 TRANSPORTE: LECTURA DE UNA HOJA (gviz JSON)
==========================================================*/

function cellValue(cell) {

    return cell && Object.prototype.hasOwnProperty.call(cell, "v") ? cell.v : null;

}

function parseGvizResponse(text) {

    const jsonStart = text.indexOf("{");

    const jsonEnd = text.lastIndexOf("}");

    return JSON.parse(text.substring(jsonStart, jsonEnd + 1));

}

function gvizTableToObjects(table) {

    const hasDetectedHeader = table.cols.some(col => col.label && col.label.trim().length > 0);

    let headers;

    let dataRows;

    if (hasDetectedHeader) {

        headers = table.cols.map(col => col.label.trim());

        dataRows = table.rows;

    } else {

        headers = table.rows[0].c.map(cell => String(cellValue(cell) || "").trim());

        dataRows = table.rows.slice(1);

    }

    return dataRows.map(row => {

        const record = {};

        headers.forEach((header, index) => {

            record[header] = cellValue(row.c ? row.c[index] : null);

        });

        return record;

    });

}

/*
    forceStringColumns=true agrega "&headers=0": le pide a gviz que
    NO infiera un tipo por columna. Es necesario para "Parámetros",
    cuya columna "valor" mezcla texto (ej. "AUD", "EUR") y montos
    (ej. "$50") — sin esto, gviz decide un único tipo para TODA la
    columna según la mayoría de filas, y las celdas que no encajan
    en ese tipo llegan como null (se pierden, sin recuperación
    posible) en vez de como el texto real de la celda. Las demás
    hojas tienen columnas de un solo tipo consistente y no lo
    necesitan.
*/

async function fetchSheetTab(gid, { forceStringColumns = false } = {}) {

    const headersParam = forceStringColumns ? "&headers=0" : "";

    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}${headersParam}`;

    const response = await fetch(url);

    if (!response.ok) {

        throw new Error(`No se pudo leer la hoja (gid=${gid}): HTTP ${response.status}`);

    }

    const text = await response.text();

    return gvizTableToObjects(parseGvizResponse(text).table);

}



/*==========================================================
 CACHÉ EN MEMORIA (ver explicación de estrategia arriba)
==========================================================*/

let sheetsCache = null;

let sheetsCacheLoadingPromise = null;

async function loadAllSheetsData(forceRefresh = false) {

    if (sheetsCache && !forceRefresh) return sheetsCache;

    if (sheetsCacheLoadingPromise && !forceRefresh) return sheetsCacheLoadingPromise;

    sheetsCacheLoadingPromise = (async () => {

        const [colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, promociones, parametrosRows] = await Promise.all([

            fetchSheetTab(SHEET_TABS.COLEGIOS),

            fetchSheetTab(SHEET_TABS.CURSOS),

            fetchSheetTab(SHEET_TABS.VISAS),

            fetchSheetTab(SHEET_TABS.SEGUROS),

            fetchSheetTab(SHEET_TABS.COSTOS_FIJOS),

            fetchSheetTab(SHEET_TABS.SERVICIOS_OPCIONALES),

            fetchSheetTab(SHEET_TABS.PROMOCIONES),

            fetchSheetTab(SHEET_TABS.PARAMETROS, { forceStringColumns: true })

        ]);

        const parametros = {};

        parametrosRows.forEach(row => {

            const key = row["Párametro"] ?? row["Parámetro"];

            if (key) parametros[normalize(key)] = row["valor"];

        });

        sheetsCache = { colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, promociones, parametros };

        return sheetsCache;

    })();

    try {

        return await sheetsCacheLoadingPromise;

    } catch (error) {

        sheetsCacheLoadingPromise = null;

        throw error;

    }

}

async function refreshDatabaseCache() {

    return loadAllSheetsData(true);

}

function isRowActive(row) {

    return !("Estado" in row) || row.Estado == null || normalize(row.Estado) === "activo";

}



/*==========================================================
 COLEGIOS
 ----------------------------------------------------------
 Filtrados por Destino (columna "Destino" de la hoja
 "Colegios"): un colegio de España nunca debe aparecer cuando
 el asesor cotiza para Australia, y viceversa.
==========================================================*/

async function fetchColleges(destination) {

    const { colegios } = await loadAllSheetsData();

    const names = colegios

        .filter(isRowActive)

        .filter(row => !destination || normalize(row["Destino"]) === normalize(destination))

        .map(row => row["Colegio"])

        .filter(Boolean);

    return [...new Set(names)];

}



/*==========================================================
 CIUDADES POR COLEGIO
 ----------------------------------------------------------
 La hoja "Colegios" no tiene columna de Ciudad: las ciudades
 disponibles se derivan de qué cursos existen realmente para
 ese colegio en la hoja "Cursos" (no tiene sentido ofrecer una
 ciudad sin cursos configurados en ella).
==========================================================*/

async function fetchCitiesByCollege(collegeName) {

    const { cursos } = await loadAllSheetsData();

    const cities = cursos

        .filter(row => normalize(row["Colegio"]) === normalize(collegeName))

        .map(row => row["Ciudad"])

        .filter(Boolean);

    return [...new Set(cities)];

}



/*==========================================================
 TIPOS DE CURSO DISPONIBLES (Colegio + Ciudad)
 ----------------------------------------------------------
 ELICOS/VET/HE siguen siendo el único universo posible de
 valores (regla de negocio fija), pero cuáles de esos tres se
 OFRECEN para un colegio+ciudad específico depende de qué haya
 realmente configurado en "Cursos".
==========================================================*/

async function fetchCourseTypesByCollegeAndCity({ college, city }) {

    const { cursos } = await loadAllSheetsData();

    const types = cursos

        .filter(row =>
            normalize(row["Colegio"]) === normalize(college) &&
            normalize(row["Ciudad"]) === normalize(city)
        )

        .map(row => normalizeCourseType(row["Tipo Curso"]))

        .filter(Boolean);

    return [...new Set(types)];

}



/*==========================================================
 SUBTIPOS Y PROGRAMAS (cascada completa)
==========================================================*/

async function fetchSubtypesByCourseSelection({ college, city, type }) {

    const { cursos } = await loadAllSheetsData();

    const subtypes = cursos

        .filter(row =>
            normalize(row["Colegio"]) === normalize(college) &&
            normalize(row["Ciudad"]) === normalize(city) &&
            normalizeCourseType(row["Tipo Curso"]) === type
        )

        .map(row => row["Subtipo"])

        .filter(Boolean);

    return [...new Set(subtypes)];

}

async function fetchProgramsByCourseSelection({ college, city, type, subtype }) {

    const { cursos } = await loadAllSheetsData();

    const programs = cursos

        .filter(row =>
            normalize(row["Colegio"]) === normalize(college) &&
            normalize(row["Ciudad"]) === normalize(city) &&
            normalizeCourseType(row["Tipo Curso"]) === type &&
            normalize(row["Subtipo"]) === normalize(subtype)
        )

        .map(row => row["Programa"])

        .filter(Boolean);

    return [...new Set(programs)];

}



/*==========================================================
 INFORMACIÓN COMPLETA DE UN CURSO
 ----------------------------------------------------------
 La duración usada para calcular el precio depende del tipo:

   - ELICOS: la hoja "Cursos" NO trae duración (la celda queda
     vacía a propósito); la duración es la que la asesora
     ingresa en el cotizador (parámetro "weeks").
   - VET / HE: la duración SIEMPRE viene de la columna
     "Duración" de la hoja — el cotizador no la pide.
==========================================================*/

async function resolveCourseDiscount(cursoRow, college, program) {

    const cursoPromo = cursoRow["Promoción"];

    if (cursoPromo !== null && cursoPromo !== undefined) {

        const amount = Number(cursoPromo) || 0;

        return { amount, description: amount > 0 ? "Promoción del curso" : null };

    }

    const { promociones } = await loadAllSheetsData();

    const match = promociones.find(row =>
        normalize(row["Colegio"]) === normalize(college) &&
        normalize(row["Nombre Curso"]) === normalize(program)
    );

    if (!match) return { amount: 0, description: null };

    return { amount: Number(match["valor"]) || 0, description: match["Promoción"] || "Promoción" };

}

async function fetchCourseDetails({ college, city, type, subtype, program, weeks }) {

    const { cursos } = await loadAllSheetsData();

    const row = cursos.find(r =>
        normalize(r["Colegio"]) === normalize(college) &&
        normalize(r["Ciudad"]) === normalize(city) &&
        normalizeCourseType(r["Tipo Curso"]) === type &&
        normalize(r["Subtipo"]) === normalize(subtype) &&
        normalize(r["Programa"]) === normalize(program)
    );

    if (!row) {

        return {

            found: false,

            price: 0,

            enrollmentFee: 0,

            materialsFee: 0,

            officialWeeks: Number(weeks) || 0,

            discount: 0,

            discountSource: null

        };

    }

    const officialWeeks = type === "ELICOS" ? (Number(weeks) || 0) : (Number(row["Duración"]) || 0);

    const weeklyRate = Number(row["Valor semana"]) || 0;

    const discountInfo = await resolveCourseDiscount(row, college, program);

    return {

        found: true,

        price: weeklyRate * officialWeeks,

        enrollmentFee: Number(row["Matrícula"]) || 0,

        materialsFee: Number(row["Materiales"]) || 0,

        officialWeeks,

        discount: discountInfo.amount,

        discountSource: discountInfo.description

    };

}



/*==========================================================
 SEGURO MÉDICO
 ----------------------------------------------------------
 La hoja "Seguros" trae una fila por cada plan (columna A,
 "seguro"), con el valor POR SEMANA de ese plan en las columnas
 "Single"/"Couple"/"Family" (una por Tipo de Cotización). La
 asesora elige el plan en el cotizador; el costo total se
 calcula multiplicando ese valor semanal por la duración total
 de la cotización (ver pricing.js#calculateInsurance).
==========================================================*/

async function fetchInsuranceOptions() {

    const { seguros } = await loadAllSheetsData();

    const names = seguros

        .map(row => String(row["seguro"] || "").trim())

        .filter(Boolean);

    return [...new Set(names)];

}

async function fetchInsuranceWeeklyRate({ insuranceName, quotationType }) {

    const { seguros } = await loadAllSheetsData();

    const row = seguros.find(r => normalize(r["seguro"]) === normalize(insuranceName));

    if (!row || !Object.prototype.hasOwnProperty.call(row, quotationType)) {

        return { weeklyRate: 0, found: false };

    }

    return { weeklyRate: Number(row[quotationType]) || 0, found: true };

}



/*==========================================================
 VISA
 ----------------------------------------------------------
 Se cobra UNA sola vez por aplicante, usando el tipo de curso
 de mayor jerarquía presente en la cotización (ver
 COURSE_TYPE_PRIORITY).
==========================================================*/

async function fetchVisaCost({ destination, courseTypes, numberApplicants }) {

    const { visas } = await loadAllSheetsData();

    const primaryType = COURSE_TYPE_PRIORITY.find(type => courseTypes.includes(type)) || null;

    if (!primaryType) return { total: 0, perApplicant: 0, primaryType: null, found: false };

    const row = visas.find(r =>
        normalize(r["Destino"]) === normalize(destination) &&
        normalizeCourseType(r["Tipo de curso"]) === primaryType
    );

    if (!row) return { total: 0, perApplicant: 0, primaryType, found: false };

    const perApplicant = Number(row["Valor visa"]) || 0;

    return { total: perApplicant * numberApplicants, perApplicant, primaryType, found: true };

}



/*==========================================================
 EXTRAS OFFSHORE (Costos Fijos)
 ----------------------------------------------------------
 Se retornan TODAS las filas que apliquen para el destino,
 sin códigos fijos por concepto: si mañana se agrega una fila
 nueva (ej. "Envío de documentos"), se incluye automáticamente
 sin tocar código.
==========================================================*/

async function fetchOffshoreExtraCosts(destination) {

    const { costosFijos } = await loadAllSheetsData();

    return costosFijos

        .filter(row =>
            normalize(row["Destino"]) === normalize(destination) &&
            normalize(row["Offshore"]) === "si"
        )

        .map(row => ({

            code: slugify(row["concepto"]),

            label: row["concepto"],

            amount: Number(row["valor"]) || 0

        }));

}



/*==========================================================
 SERVICIOS OPCIONALES
==========================================================*/

async function fetchServiceCatalog() {

    const { serviciosOpcionales } = await loadAllSheetsData();

    return serviciosOpcionales

        .filter(row => row["Servicio"])

        .map(row => ({

            code: slugify(row["Servicio"]),

            label: row["Servicio"],

            unitCost: Number(row["Precio"]) || 0

        }));

}



/*==========================================================
 PARÁMETROS GENERALES
==========================================================*/

async function fetchParameter(name) {

    const { parametros } = await loadAllSheetsData();

    const value = parametros[normalize(name)];

    return value === undefined ? null : value;

}

/*
    Con forceStringColumns, "valor" siempre llega como texto (ej.
    "$700", "$50") — nunca como number ni con formato de moneda ya
    aplicado. parseMoneyString() le quita cualquier símbolo/separador
    que no sea dígito, punto o signo antes de convertir a number.
*/

function parseMoneyString(value) {

    if (value === null || value === undefined) return 0;

    const cleaned = String(value).replace(/[^0-9.-]/g, "");

    return Number(cleaned) || 0;

}

async function fetchSecondApplicationSurcharge() {

    const value = await fetchParameter("Recargo segunda aplicación Onshore");

    return parseMoneyString(value);

}

/*
    Costos Extras (exámenes médicos y biométricos): valores
    genéricos configurables en la hoja "Parámetros" (filas "Exámenes
    Biométricos"/"Exámenes Médicos", columna "valor"), igual
    filosofía que el recargo de segunda aplicación — se pagan
    directamente a cada entidad proveedora del servicio, nunca
    se suman al total principal (ver pricing.js#calculateExtraCosts).
    NO se multiplican por semanas: es un valor fijo, a diferencia
    del seguro médico (valor semanal × duración).
*/

async function fetchMedicalExamCost() {

    const value = await fetchParameter("Exámenes Médicos");

    return parseMoneyString(value);

}

async function fetchBiometricExamCost() {

    const value = await fetchParameter("Exámenes Biométricos");

    return parseMoneyString(value);

}

async function fetchCurrencyForDestination(destination) {

    if (!destination) return "AUD";

    const value = await fetchParameter(`Moneda ${destination}`);

    return value || "AUD";

}
