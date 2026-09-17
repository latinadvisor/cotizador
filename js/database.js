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
     Ciudad->Tipo->Programa) sería lento e innecesario: el
     asesor vería un pequeño delay en cada select, varias
     veces por cotización.
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
 - La hoja "Cursos" trae una columna "Total" ya calculada
   manualmente, que nunca se lee: el precio siempre se
   recalcula en este archivo a partir de Valor semana ×
   Duración (+ Matrícula/Materiales en pricing.js), para no
   depender de una celda que podría quedar desactualizada.
 - Los descuentos ya NO vienen de una columna "Promoción" en
   Cursos: desde la v3 (Motor de Promociones) toda promoción
   vive exclusivamente en la hoja "Promociones", evaluada por
   evaluatePromotionsForCourse() más abajo. Ver esa sección
   para el detalle de columnas/tipos soportados.
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

    PARAMETROS: 916827119,

    PRIMER_DEPOSITO_ONSHORE: 447913787

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

/*
    OPCIÓN "TODOS LOS CAMPUS" (ver fetchCitiesByCollege más abajo).
    Es un valor de UI, nunca un valor real de la columna "Ciudad" del
    Sheet — por eso ninguna fila real puede calzar con él por accidente.

    Un colegio puede mezclar filas con Ciudad específica y filas
    comodín (Ciudad vacía) para el mismo Tipo/Programa (ej.
    Greenwich College: la mayoría de sus cursos son comodín, pero
    algunos traen precio distinto en Sydney/Melbourne/Brisbane). El
    comodín aplica a CUALQUIER ciudad, así que las funciones de cascada
    (fetchCourseTypesByCollegeAndCity/fetchProgramsByCourseSelection)
    deben ofrecer, para una ciudad
    específica, la UNIÓN de sus filas propias + las filas comodín —
    nunca solo una de las dos. matchesCityFilter() centraliza esa
    regla. fetchCourseDetails/resolveCourseRow ya resuelven esto solos
    (ver resolveCourseRow) porque hacen match exacto primero y solo
    caen al comodín si NINGUNA fila de la ciudad exacta calificó — por
    eso no usan este helper.
*/
const ALL_CITIES_OPTION = "Todos los campus";

/*
    Igual que criterionMatches() (ver más abajo) pero para la columna
    "Ciudad" de la hoja "Cursos": admite varias ciudades separadas por
    coma en una misma celda (ej. "Sydney,Melbourne") para no tener que
    duplicar la fila por cada ciudad donde se ofrece el mismo curso al
    mismo precio. Una celda vacía sigue significando comodín (aplica a
    cualquier ciudad) — eso lo maneja cada llamador comparando el
    resultado con [] (length === 0), no esta función.
*/
function splitCityValues(rawValue) {

    const raw = String(rawValue == null ? "" : rawValue).trim();

    if (!raw) return [];

    return raw.split(",").map(value => value.trim()).filter(Boolean);

}

function matchesCityFilter(row, city) {

    const cityValues = splitCityValues(row["Ciudad"]);

    if (city === ALL_CITIES_OPTION) return cityValues.length === 0;

    if (cityValues.length === 0) return true;

    return cityValues.some(value => normalize(value) === normalize(city));

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

        const [colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, promociones, parametrosRows, primerDepositoOnshore] = await Promise.all([

            fetchSheetTab(SHEET_TABS.COLEGIOS),

            fetchSheetTab(SHEET_TABS.CURSOS),

            fetchSheetTab(SHEET_TABS.VISAS),

            fetchSheetTab(SHEET_TABS.SEGUROS),

            fetchSheetTab(SHEET_TABS.COSTOS_FIJOS),

            fetchSheetTab(SHEET_TABS.SERVICIOS_OPCIONALES),

            fetchSheetTab(SHEET_TABS.PROMOCIONES),

            fetchSheetTab(SHEET_TABS.PARAMETROS, { forceStringColumns: true }),

            fetchSheetTab(SHEET_TABS.PRIMER_DEPOSITO_ONSHORE)

        ]);

        const parametros = {};

        parametrosRows.forEach(row => {

            const key = row["Párametro"] ?? row["Parámetro"];

            if (key) parametros[normalize(key)] = row["valor"];

        });

        sheetsCache = { colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, promociones, parametros, primerDepositoOnshore };

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

    const collegeRows = cursos.filter(row => normalize(row["Colegio"]) === normalize(collegeName));

    // Una fila con Ciudad="Sydney,Melbourne" debe aportar AMBAS ciudades
    // como opciones separadas del desplegable, no una sola opción rara
    // con la coma incluida — ver splitCityValues().
    const cities = [];
    const seenCities = new Set();

    collegeRows.forEach(row => {

        splitCityValues(row["Ciudad"]).forEach(city => {

            if (seenCities.has(city)) return;

            seenCities.add(city);

            cities.push(city);

        });

    });

    // Si al menos una fila de este colegio trae "Ciudad" vacía, esa fila
    // aplica a cualquier campus (ver comodín en resolveCourseRow) — se
    // ofrece como opción explícita "Todos los campus" en vez de exigir
    // duplicar la fila por cada ciudad habilitada.
    const hasWildcard = collegeRows.some(row => splitCityValues(row["Ciudad"]).length === 0);

    return hasWildcard ? [ALL_CITIES_OPTION, ...cities] : cities;

}

/*==========================================================
 CIUDADES HABILITADAS EN EL COTIZADOR (para el campo "Ciudad
 seleccionada por el estudiante" que aparece cuando se elige
 "Todos los campus" — ver courses.js#toggleStudentCityField)
 ----------------------------------------------------------
 "Todos los campus" le dice al sistema que ese colegio/curso no
 necesita ciudad para calcular precio (ver comodín de Ciudad
 arriba), pero la asesora igual necesita registrar en qué ciudad
 quiere estudiar el estudiante, para que aparezca en el PDF —
 ese campo es un selector, no texto libre, para evitar errores
 de tipeo ("Sidney", "Sydny", etc.).

 La lista combina las ciudades australianas más relevantes
 (decisión confirmada del cliente) con cualquier otra Ciudad que
 ya exista en la hoja "Cursos" (de cualquier colegio) y no esté
 en esa lista — así un colegio con una ciudad poco común nunca
 queda fuera del selector.
==========================================================*/
const AUSTRALIA_ENABLED_CITIES = [
    "Sydney", "Melbourne", "Brisbane", "Gold Coast", "Perth",
    "Adelaide", "Canberra", "Hobart", "Darwin", "Cairns", "Sunshine Coast"
];

async function fetchAllEnabledCities() {

    const { cursos } = await loadAllSheetsData();

    const cities = [...AUSTRALIA_ENABLED_CITIES];

    cursos.forEach(row => {

        splitCityValues(row["Ciudad"]).forEach(city => {

            const alreadyListed = cities.some(existing => normalize(existing) === normalize(city));

            if (!alreadyListed) cities.push(city);

        });

    });

    return cities;

}

/*
    Ciudad a MOSTRAR en PDF/resumen/CRM para un curso: si se eligió
    "Todos los campus", la ciudad real es la que la asesora escribió
    aparte en "studentCity" (nunca el texto "Todos los campus", que no
    le dice nada al estudiante) — si se eligió una ciudad puntual, esa
    es directamente la ciudad a mostrar.
*/
function resolveCourseDisplayCity(course) {

    if (!course) return "";

    if (course.city === ALL_CITIES_OPTION) return course.studentCity || "";

    return course.city || "";

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
            matchesCityFilter(row, city)
        )

        .map(row => normalizeCourseType(row["Tipo Curso"]))

        .filter(Boolean);

    return [...new Set(types)];

}



/*==========================================================
 PROGRAMAS (cascada completa)
 ----------------------------------------------------------
 Hasta la v-Subtipo, este paso pasaba por un nivel intermedio
 "Subtipo" (Colegio+Ciudad+Tipo -> Subtipo -> Programa). Se
 eliminó (decisión confirmada del cliente): la columna "Subtipo"
 ya no existe en "Cursos" — ahora Programa se deriva directo de
 Colegio+Ciudad+Tipo. En colegios con muchos programas bajo un
 mismo Tipo (ej. SBTA VET) el desplegable de Programa queda más
 largo que antes; es un cambio de UX aceptado, no un bug.
==========================================================*/

async function fetchProgramsByCourseSelection({ college, city, type }) {

    const { cursos } = await loadAllSheetsData();

    const programs = cursos

        .filter(row =>
            normalize(row["Colegio"]) === normalize(college) &&
            matchesCityFilter(row, city) &&
            normalizeCourseType(row["Tipo Curso"]) === type
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

/*==========================================================
 MOTOR DE PROMOCIONES
 ----------------------------------------------------------
 Reemplaza por completo el mecanismo viejo (columna "Promoción"
 de Cursos + hoja "Promociones" con match Colegio+Nombre Curso).
 Decisión del cliente: las promociones activas de ese mecanismo
 deben migrarse a mano a la hoja nueva; no coexisten los dos.

 La hoja "Promociones" ahora trae UNA fila por regla, con estas
 columnas (vacío en un criterio = aplica a todos):

   ID_PROMOCION, ACTIVA, COLEGIO, CAMPUS, PROGRAMA, SUBPROGRAMA,
   MODALIDAD, HORARIO, NACIONALIDAD, CIUDAD, SEMANAS_MIN,
   SEMANAS_MAX, PRIORIDAD, COMBINABLE, TIPO_PROMOCION, VALOR,
   OBSERVACIONES

 CAMPUS se compara contra la Ciudad del curso (hoy no existe un
 concepto de "campus" separado en la hoja Cursos). MODALIDAD se
 compara contra el Tipo de Curso (ELICOS/VET/HE).

 Cuando varias filas coinciden en el mismo curso: se ordenan por
 PRIORIDAD (menor número = mayor prioridad) y se aplica siempre
 la primera. Si esa fila tiene COMBINABLE=SI, se van sumando las
 siguientes (en orden de prioridad) mientras también sean
 COMBINABLE=SI; se detiene en la primera que no lo sea.

 SEMANAS_GRATIS es un caso especial: es un BONO INFORMATIVO, no
 un descuento (caso real confirmado: "Aussie English Bonus
 Weeks" — el estudiante paga el precio completo de las semanas
 reservadas, la semana de regalo es tiempo de estudio extra que
 NUNCA resta de Total Programa/Descuento/Total). Por eso se
 excluye del cálculo de precio en fetchCourseDetails y solo
 aparece como nota en el bloque "🎉 Promoción aplicada" del PDF
 (ver database.js#buildPromotionEffect / pdf.js#buildPromotionBlock).

 COMBINABLE admite 3 valores (decisión confirmada del cliente):
   - SI: se combina con otras de su MISMO carril (ver abajo).
   - NO (o vacío): no se combina, pero solo compite dentro de su
     propio carril — no bloquea el otro carril.
   - EXCLUSIVA: gana ella sola, bloqueando TODO lo demás (ambos
     carriles), sin importar prioridad de las otras filas.

 Las promociones se evalúan en 2 carriles INDEPENDIENTES que
 nunca compiten entre sí (arreglo confirmado tras detectar que
 un bono podía bloquear sin sentido un descuento real):
   - Carril de PRECIO (descuentos/precio especial/matrícula-
     materiales gratis/pague X estudie Y): prioridad+combinable
     se resuelven SOLO entre las de este carril.
   - Carril de BONOS informativos (semanas gratis): prioridad+
     combinable se resuelven SOLO entre las de este carril.
 Por eso, sin EXCLUSIVA, siempre puede mostrarse a la vez el
 ganador de cada carril (un descuento real Y un bono informativo
 juntos) — son beneficios de naturaleza distinta.
==========================================================*/

/*
    Admite varios valores separados por coma en una misma celda (ej.
    NACIONALIDAD = "Chilena,Argentina,Uruguaya,Mexicana,Brasileña") para
    no tener que crear una fila idéntica por cada valor — aplica a
    CUALQUIER criterio, no solo Nacionalidad. Ignora acentos/mayúsculas
    en ambos lados (la persona que llena el Sheet puede escribir
    "Brasilena" sin ñ y de todos modos calza).
*/

function criterionMatches(cellValue, candidate) {

    const raw = String(cellValue == null ? "" : cellValue).trim();

    if (!raw) return true; // vacío = aplica a todos

    const candidateNormalized = stripAccents(normalize(candidate));

    const allowedValues = raw.split(",").map(value => stripAccents(normalize(value)));

    return allowedValues.includes(candidateNormalized);

}

function weeksInRange(row, weeks) {

    const min = row["SEMANAS_MIN"];

    const max = row["SEMANAS_MAX"];

    if (min !== "" && min !== null && min !== undefined && weeks < Number(min)) return false;

    if (max !== "" && max !== null && max !== undefined && weeks > Number(max)) return false;

    return true;

}

/*
    FECHA_INICIO/FECHA_FIN (vigencia) — ambas vacías = sin límite de
    fechas, igual que hoy. Formato esperado en el Sheet: AAAA-MM-DD.
*/
function isWithinValidityDates(row) {

    const today = new Date();

    const start = row["FECHA_INICIO"] ? new Date(row["FECHA_INICIO"]) : null;

    const end = row["FECHA_FIN"] ? new Date(row["FECHA_FIN"]) : null;

    if (start && !isNaN(start) && today < start) return false;

    if (end && !isNaN(end) && today > end) return false;

    return true;

}

function defaultPromotionDescription(tipo, valor) {

    switch (tipo) {

        case "precio_semana_especial": return `Precio especial por semana: $${valor}`;

        case "descuento_porcentaje": return `${valor}% de descuento`;

        case "descuento_fijo": return `Descuento de $${valor}`;

        case "semanas_gratis": return `Incluye ${valor} semana(s) adicional(es) de estudio sin costo`;

        case "pague_x_estudie_y": return `Paga ${valor} semanas`;

        case "matricula_gratis": return "Matrícula gratis";

        case "materiales_gratis": return "Materiales gratis";

        case "servicio_gratis": return "Servicio adicional sin costo";

        case "personalizada": return "Promoción especial";

        default: return "Promoción";

    }

}

/*
    Si la fila deja AFECTA_PRECIO vacío (filas cargadas antes de que
    existiera esta columna), se usa este respaldo según el tipo — pero
    el valor real de la columna, cuando está presente, SIEMPRE manda.
    Esto es lo que reemplaza la regla fija que antes tenía yo en el
    código ("SEMANAS_GRATIS siempre es informativa") — ahora es un dato
    configurable por fila, no una decisión fija del programador.
*/
const PRICE_AFFECTING_BY_DEFAULT = new Set([
    "precio_semana_especial", "descuento_porcentaje", "descuento_fijo",
    "pague_x_estudie_y", "matricula_gratis", "materiales_gratis"
]);

/*
    MODO_APLICACION=POR_BLOQUE: el beneficio se repite automáticamente
    cada PARAM_SEMANAS_BLOQUE semanas completas (ej. cada 12 semanas
    reservadas), opcionalmente topado por PARAM_TOPE_BLOQUES para que un
    dato mal cargado no genere un descuento sin límite. MODO_APLICACION
    vacío o "UNICA" = se aplica una sola vez (multiplicador 1), igual
    que todas las promociones de hoy — este es el comportamiento por
    defecto, así que ninguna fila existente se ve afectada.
*/
function resolveBlockMultiplier(row, weeks) {

    if (normalize(row["MODO_APLICACION"]) !== "por_bloque") return 1;

    const blockSize = Number(row["PARAM_SEMANAS_BLOQUE"]) || 0;

    if (blockSize <= 0) return 1;

    const blocksCompleted = Math.floor(weeks / blockSize);

    const cap = row["PARAM_TOPE_BLOQUES"];

    const maxBlocks = (cap !== "" && cap !== null && cap !== undefined) ? Number(cap) : Infinity;

    return Math.min(blocksCompleted, maxBlocks);

}

function buildPromotionEffect(row, weeks) {

    const tipo = normalize(row["TIPO_PROMOCION"]);

    // PARAM_VALOR es el nombre nuevo de esta columna — se sigue leyendo
    // VALOR como respaldo para no romper filas cargadas antes del
    // rediseño de arquitectura (ver .docs/columnas-promociones.md).
    const valor = Number(row["PARAM_VALOR"] ?? row["VALOR"]) || 0;

    const description = String(row["OBSERVACIONES"] || "").trim() || defaultPromotionDescription(tipo, valor);

    const afectaPrecioCell = normalize(row["AFECTA_PRECIO"]);

    const isPriceAffecting = afectaPrecioCell
        ? afectaPrecioCell === "si"
        : PRICE_AFFECTING_BY_DEFAULT.has(tipo);

    const blockMultiplier = resolveBlockMultiplier(row, weeks);

    const effect = {

        id: row["ID_PROMOCION"],

        description,

        isPriceAffecting,

        weeklyRateOverride: null,

        chargeableWeeksOverride: null,

        percentOff: 0,

        fixedOff: 0,

        freeWeeks: 0,

        waiveEnrollment: false,

        waiveMaterials: false

    };

    if (tipo === "precio_semana_especial") effect.weeklyRateOverride = valor;

    else if (tipo === "descuento_porcentaje") effect.percentOff = valor;

    else if (tipo === "descuento_fijo") effect.fixedOff = valor * blockMultiplier;

    else if (tipo === "semanas_gratis") effect.freeWeeks = valor * blockMultiplier;

    else if (tipo === "pague_x_estudie_y") effect.chargeableWeeksOverride = valor;

    else if (tipo === "matricula_gratis") effect.waiveEnrollment = true;

    else if (tipo === "materiales_gratis") effect.waiveMaterials = true;

    // servicio_gratis / personalizada: sin efecto numérico, siempre
    // terminan en el carril informativo (bonusNotes) salvo que alguien
    // marque AFECTA_PRECIO=SI a propósito, en cuyo caso no hacen nada al
    // precio de todos modos (son beneficios que no se calculan solos,
    // ver .docs/columnas-promociones.md).

    return effect;

}

/*
    Resuelve prioridad/combinabilidad DENTRO de un solo grupo de efectos
    ya construidos (ver comentario de selectPromotionEffects más abajo
    sobre por qué esto corre por separado para bonos vs. promociones con
    precio).
*/

function selectByPriority(effects) {

    if (effects.length === 0) return [];

    const withPriority = effects

        .map(effect => ({

            effect,

            priority: (effect.priority !== "" && effect.priority !== null && effect.priority !== undefined)
                ? Number(effect.priority)
                : Number.MAX_SAFE_INTEGER

        }))

        .sort((a, b) => a.priority - b.priority);

    const selected = [withPriority[0]];

    if (normalize(withPriority[0].effect.combinable) === "si") {

        for (let i = 1; i < withPriority.length; i++) {

            if (normalize(withPriority[i].effect.combinable) !== "si") break;

            selected.push(withPriority[i]);

        }

    }

    return selected.map(({ effect }) => effect);

}

/*
    Los bonos informativos (SEMANAS_GRATIS) y las promociones que sí
    afectan precio compiten por PRIORIDAD/COMBINABLE cada uno en su
    propio grupo, nunca entre sí — de lo contrario un bono podría
    "bloquear" un descuento real (o viceversa) solo por coincidir en
    prioridad y no ser combinable, algo que no tiene sentido de negocio:
    son dos cosas independientes (ver database.js#buildPromotionEffect).
*/

async function evaluatePromotionsForCourse({ college, city, program, subtype, type, schedule, nationality, weeks, applicationType }) {

    const { promociones } = await loadAllSheetsData();

    const candidates = promociones.filter(row => {

        if (normalize(row["ACTIVA"]) !== "si") return false;

        return criterionMatches(row["COLEGIO"], college) &&
            criterionMatches(row["CAMPUS"], city) &&
            criterionMatches(row["PROGRAMA"], program) &&
            criterionMatches(row["SUBPROGRAMA"], subtype) &&
            criterionMatches(row["MODALIDAD"], type) &&
            criterionMatches(row["HORARIO"], schedule) &&
            criterionMatches(row["NACIONALIDAD"], nationality) &&
            criterionMatches(row["CIUDAD"], city) &&
            criterionMatches(row["APLICACION"], applicationType) &&
            weeksInRange(row, weeks) &&
            isWithinValidityDates(row);

    });

    const effects = candidates.map(row => ({

        ...buildPromotionEffect(row, weeks),

        priority: row["PRIORIDAD"],

        combinable: row["COMBINABLE"]

    }));

    if (effects.length === 0) return [];

    // EXCLUSIVA gana ella sola, bloqueando AMBOS carriles — se resuelve
    // antes de separar por carril. selectByPriority ya deja solo 1
    // resultado acá porque "exclusiva" !== "si" (no se combina).
    const exclusiveEffects = effects.filter(effect => normalize(effect.combinable) === "exclusiva");

    if (exclusiveEffects.length > 0) return selectByPriority(exclusiveEffects);

    const priceAffecting = selectByPriority(effects.filter(effect => effect.isPriceAffecting));

    const bonuses = selectByPriority(effects.filter(effect => !effect.isPriceAffecting));

    return [...priceAffecting, ...bonuses];

}

/*
    Tarifa semanal según Horario ("Valor semana Mañana/Tarde/Noche
    offshore|onshore"), con "Valor semana offshore|onshore" como
    respaldo si el curso no tiene tarifa propia para ese horario (o
    si no se seleccionó horario). El bloque de columnas a usar
    (I:L offshore, M:P onshore) depende del Tipo de Aplicación de la
    cotización. NO es una promoción — es el precio de catálogo.
*/

function resolveWeeklyRate(row, schedule, applicationType) {

    const suffix = applicationType === "Onshore" ? "onshore" : "offshore";

    const scheduleRate = schedule ? (Number(row[`Valor semana ${schedule} ${suffix}`]) || 0) : 0;

    return scheduleRate > 0 ? scheduleRate : (Number(row[`Valor semana ${suffix}`]) || 0);

}

/*
    TARIFAS POR NACIONALIDAD (columna "Nacionalidad" de la hoja "Cursos")
    ----------------------------------------------------------
    Reemplaza el enfoque de una pestaña "Tarifas Especiales" separada
    (nunca llegó a programarse — quedó solo como CSV de ejemplo,
    descartado) por una columna dentro de la propia hoja "Cursos": ahora
    puede haber VARIAS filas para el mismo Colegio+Ciudad+Tipo+
    Programa+Rango de duración, una por nacionalidad/continente, y se resuelve por
    prioridad, deteniéndose en la primera coincidencia válida (decisión
    confirmada del cliente):

      1. Coincidencia EXACTA de nacionalidad (ej. "Brasileña") — admite
         listas separadas por coma, igual que en Promociones (reutiliza
         criterionMatches, ver más abajo).
      2. Coincidencia de continente (LATAM/Europa/Asia/África), resuelto
         desde el PAÍS del estudiante (no desde su gentilicio — ver
         countries.js#resolveContinentForCountry para el porqué).
      3. Fila con "Nacionalidad" vacía = aplica a cualquier estudiante.

    Una fila con "Nacionalidad" vacía SIEMPRE se trata como universal,
    nunca como criterio de continente/nacionalidad — por eso cada
    verificación exige primero que la celda no esté vacía.
*/
function resolveCourseRowByNationality(candidates, nationality, country) {

    const exactMatch = candidates.find(r => {
        const cell = String(r["Nacionalidad"] || "").trim();
        return cell !== "" && criterionMatches(cell, nationality);
    });

    if (exactMatch) return exactMatch;

    const continent = resolveContinentForCountry(country);

    if (continent) {

        const continentMatch = candidates.find(r => {
            const cell = String(r["Nacionalidad"] || "").trim();
            return cell !== "" && criterionMatches(cell, continent);
        });

        if (continentMatch) return continentMatch;

    }

    return candidates.find(r => String(r["Nacionalidad"] || "").trim() === "") || null;

}

/*
    RANGO DE DURACIÓN ("Semanas desde"/"Semanas hasta" de "Cursos"):
    reemplaza a la antigua columna "Subtipo" para el caso real que
    representaba (colegios que cobran distinto según cuántas semanas
    contrata el estudiante, ej. Greenwich 1-10/11-20/21+ semanas).

    Mismo principio de comodín que Ciudad/Nacionalidad: una fila SIN
    rango (ambas columnas vacías) aplica a CUALQUIER duración. Si
    existen filas con rango específico Y una fila comodín para el
    mismo Colegio+Tipo+Programa, se prioriza el rango específico que
    sí cubra las semanas cotizadas; el comodín solo entra si NINGUNA
    fila con rango específico cubre esas semanas (Opción A, decisión
    confirmada del cliente) — igual patrón que ya usa Ciudad más abajo.

    Solo tiene efecto real en ELICOS (única modalidad donde la
    asesora elige la semana; en VET/HE la duración sale fija de la
    fila vía "Duración" y nadie llena este rango ahí).
*/
function hasSpecificDurationRange(row) {

    const from = row["Semanas desde"];

    const to = row["Semanas hasta"];

    return (from !== "" && from !== null && from !== undefined) ||
        (to !== "" && to !== null && to !== undefined);

}

function matchesDurationRange(row, weeks) {

    const from = row["Semanas desde"];

    const to = row["Semanas hasta"];

    const numericWeeks = Number(weeks) || 0;

    if (from !== "" && from !== null && from !== undefined && numericWeeks < Number(from)) return false;

    if (to !== "" && to !== null && to !== undefined && numericWeeks > Number(to)) return false;

    return true;

}

function filterByDurationRange(candidates, weeks) {

    const specific = candidates.filter(r => hasSpecificDurationRange(r) && matchesDurationRange(r, weeks));

    if (specific.length > 0) return specific;

    return candidates.filter(r => !hasSpecificDurationRange(r));

}

/*
    CIUDAD: misma idea de comodín que "Nacionalidad" vacía, pero para
    Ciudad — una fila con "Ciudad" vacía aplica a CUALQUIER campus de
    ese Colegio (decisión confirmada del cliente: cuando el precio
    base no varía entre campus, evita repetir la fila por cada
    ciudad). Se prioriza la ciudad exacta: si hay al menos una fila
    para la ciudad exacta (aunque sea solo la universal de
    Nacionalidad), se usa esa — el comodín de Ciudad solo entra si
    NINGUNA fila de la ciudad exacta calificó.

    También admite varias ciudades separadas por coma en una misma
    celda (ej. "Sydney,Melbourne") vía splitCityValues() — mismo precio
    para varios campus sin duplicar la fila. "Sydney/Melbourne" (con
    slash u otro separador) NO se reconoce: se trata como una sola
    ciudad literal rara y no calzará con ningún campus real.
*/
function resolveCourseRow(cursos, { college, city, type, program, nationality, country, weeks }) {

    const baseCandidates = cursos.filter(r =>
        normalize(r["Colegio"]) === normalize(college) &&
        normalizeCourseType(r["Tipo Curso"]) === type &&
        normalize(r["Programa"]) === normalize(program)
    );

    if (baseCandidates.length === 0) return null;

    const cityCandidates = baseCandidates.filter(r =>
        splitCityValues(r["Ciudad"]).some(value => normalize(value) === normalize(city))
    );

    const durationCandidates = filterByDurationRange(cityCandidates, weeks);

    const cityMatch = resolveCourseRowByNationality(durationCandidates, nationality, country);

    if (cityMatch) return cityMatch;

    const anyCityCandidates = baseCandidates.filter(r => splitCityValues(r["Ciudad"]).length === 0);

    const anyCityDurationCandidates = filterByDurationRange(anyCityCandidates, weeks);

    return resolveCourseRowByNationality(anyCityDurationCandidates, nationality, country);

}

async function fetchCourseDetails({ college, city, type, subtype, program, weeks, schedule, nationality, country, applicationType }) {

    const { cursos } = await loadAllSheetsData();

    const row = resolveCourseRow(cursos, { college, city, type, program, nationality, country, weeks });

    if (!row) {

        return {

            found: false,

            price: 0,

            enrollmentFee: 0,

            materialsFee: 0,

            officialWeeks: Number(weeks) || 0,

            discount: 0,

            discountSource: null,

            bonusNotes: [],

            priceDiscount: 0,

            enrollmentFeeWaivedAmount: 0,

            materialsFeeWaivedAmount: 0,

            onshoreWeeklyRate: 0

        };

    }

    const officialWeeks = type === "ELICOS" ? (Number(weeks) || 0) : (Number(row["Duración"]) || 0);

    const catalogWeeklyRate = resolveWeeklyRate(row, schedule, applicationType);

    const catalogEnrollmentFee = Number(row["Matrícula"]) || 0;

    /*
        MATERIALES: "Indicador de Materiales" (Cursos) decide si la celda
        "Materiales" es un valor plano (una sola vez, como siempre fue) o
        un valor POR SEMANA que hay que multiplicar por la duración del
        curso (decisión confirmada del cliente, para colegios que de
        verdad cobran materiales semana a semana). Cualquier valor que no
        sea exactamente "Por semana" (vacío, "Valor Fijo", un typo, una
        fila vieja sin este indicador) se trata como plano — es el
        comportamiento de SIEMPRE, para no romper filas ya cargadas que
        aún no fueron migradas a este indicador.
    */
    const materialsRaw = Number(row["Materiales"]) || 0;

    const isMaterialsPerWeek = normalize(row["Indicador de Materiales"]) === normalize("Por semana");

    const catalogMaterialsFee = isMaterialsPerWeek ? materialsRaw * officialWeeks : materialsRaw;

    const catalogPrice = catalogWeeklyRate * officialWeeks;

    const catalogTotal = catalogPrice + catalogEnrollmentFee + catalogMaterialsFee;

    const promotions = await evaluatePromotionsForCourse({

        college, city, program, subtype, type, schedule, nationality, applicationType, weeks: officialWeeks

    });

    // Solo las promociones "isPriceAffecting" entran al cálculo de precio
    // — SEMANAS_GRATIS queda afuera a propósito (ver buildPromotionEffect).
    const priceAffectingPromotions = promotions.filter(effect => effect.isPriceAffecting);

    const bonusPromotions = promotions.filter(effect => !effect.isPriceAffecting);

    let weeklyRate = catalogWeeklyRate;

    let chargeableWeeks = officialWeeks;

    let freeWeeksTotal = 0;

    let enrollmentWaived = false;

    let materialsWaived = false;

    let percentOff = 0;

    let fixedOff = 0;

    priceAffectingPromotions.forEach(effect => {

        if (effect.weeklyRateOverride != null) weeklyRate = effect.weeklyRateOverride;

        if (effect.chargeableWeeksOverride != null) chargeableWeeks = effect.chargeableWeeksOverride;

        freeWeeksTotal += effect.freeWeeks;

        if (effect.waiveEnrollment) enrollmentWaived = true;

        if (effect.waiveMaterials) materialsWaived = true;

        percentOff += effect.percentOff;

        fixedOff += effect.fixedOff;

    });

    /*
        SEMANAS_GRATIS con AFECTA_PRECIO=SI (ej. ILSC "Paga 10, Estudia
        12"): reduce cuántas semanas se cobran, NUNCA officialWeeks (la
        duración real sigue sin tocarse para Visa/Seguro/umbral de 25
        semanas, mismo principio ya confirmado con Aussie English).
    */
    chargeableWeeks = Math.max(0, chargeableWeeks - freeWeeksTotal);

    let programPrice = weeklyRate * chargeableWeeks;

    programPrice = programPrice * (1 - Math.min(percentOff, 100) / 100);

    programPrice = Math.max(0, programPrice - fixedOff);

    const finalEnrollmentFee = enrollmentWaived ? 0 : catalogEnrollmentFee;

    const finalMaterialsFee = materialsWaived ? 0 : catalogMaterialsFee;

    const finalTotal = programPrice + finalEnrollmentFee + finalMaterialsFee;

    // "Descuento" = beneficio real en dólares vs. el precio de catálogo
    // (ya con la tarifa de Horario aplicada), sea cual sea el tipo de
    // promoción — así "Total Programa" sigue siendo el precio de
    // catálogo (sin promoción) y "Descuento" siempre es la diferencia,
    // sin duplicar ni recalcular nada aparte (ver pricing.js#assembleTotals).
    const discount = Math.max(0, catalogTotal - finalTotal);

    const discountSource = priceAffectingPromotions.length > 0
        ? priceAffectingPromotions.map(effect => effect.description).join(" + ")
        : null;

    // Bonos informativos (SEMANAS_GRATIS) — nunca afectan precio/descuento,
    // solo se muestran como nota aparte en el PDF (ver pdf.js#buildPromotionBlock).
    const bonusNotes = bonusPromotions.map(effect => effect.description);

    /*
        Desglose de "discount" en sus 2 componentes — necesarios para la
        fórmula de Primer Pago Offshore ≥25 semanas (ver
        pricing.js#calculateOffshoreFirstPayment25Plus): ese cálculo resta
        SOLO el descuento de precio del curso, nunca el valor de matrícula/
        materiales gratis (que se suman aparte, ya en $0 si corresponde).
        `discount` en sí NO cambia — sigue siendo la suma de ambos, para
        "Descuento" en pantalla/PDF exactamente como hoy.
    */
    const priceDiscount = Math.max(0, catalogPrice - programPrice);

    const enrollmentFeeWaivedAmount = enrollmentWaived ? catalogEnrollmentFee : 0;

    const materialsFeeWaivedAmount = materialsWaived ? catalogMaterialsFee : 0;

    return {

        found: true,

        price: catalogPrice,

        enrollmentFee: catalogEnrollmentFee,

        materialsFee: catalogMaterialsFee,

        officialWeeks,

        discount,

        discountSource,

        bonusNotes,

        priceDiscount,

        enrollmentFeeWaivedAmount,

        materialsFeeWaivedAmount,

        // Tarifa semanal Onshore de catálogo (sin promoción) — insumo de
        // la fórmula "semanas de estudio" del Primer Depósito Onshore
        // parametrizado (ver fetchOnshoreDepositCondition/
        // computeOnshoreDepositBase más abajo y
        // pricing.js#applyOnshoreFirstPaymentDeposits). Irrelevante para
        // Offshore, donde el Primer Pago no depende de esto.
        onshoreWeeklyRate: applicationType === "Onshore" ? catalogWeeklyRate : 0

    };

}

/*==========================================================
 PRIMER DEPÓSITO ONSHORE (pestaña "Primer depósito Onshore")
 ----------------------------------------------------------
 Reemplaza a la antigua columna "Primer deposito" de "Cursos"
 (eliminada) — ahora la condición vive UNA vez por Colegio en su
 propia pestaña (Colegio, Tipo de condición, Parámetro), para
 poder ajustarla sin tocar código. Solo aplica a Onshore.

 Tipos de condición soportados hoy (ver
 pricing.js#applyOnshoreFirstPaymentDeposits para dónde se usa):
   - "Valor fijo": el Parámetro ES el depósito base en AUD.
   - "Semanas de estudio": el Parámetro es un número de semanas;
     el depósito base = tarifa semanal Onshore cotizada × ese
     número (sin tope — se usa el parámetro completo siempre,
     decisión confirmada del cliente).

 En ambos casos, al depósito base se le suma la Matrícula y los
 Materiales YA RESUELTOS de ese curso (netos de la regla de
 matrícula única por colegio y de cualquier promoción de
 matrícula/materiales gratis) — por eso este cálculo no puede
 vivir aquí mismo: tiene que ejecutarse en pricing.js DESPUÉS de
 applyInstitutionEnrollmentFeeRule(), cuando esos valores ya son
 definitivos.
*/
async function fetchOnshoreDepositCondition(college) {

    const { primerDepositoOnshore } = await loadAllSheetsData();

    const row = primerDepositoOnshore.find(r => normalize(r["Colegio"]) === normalize(college));

    if (!row) return { found: false, tipo: "", parametro: 0 };

    return {

        found: true,

        tipo: normalize(row["Tipo de condición"]),

        parametro: Number(row["Parámetro"]) || 0

    };

}

function computeOnshoreDepositBase(condition, onshoreWeeklyRate) {

    if (condition.tipo === normalize("Valor fijo")) return condition.parametro;

    if (condition.tipo === normalize("Semanas de estudio")) return onshoreWeeklyRate * condition.parametro;

    return 0;

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

            unitCost: Number(row["Precio"]) || 0,

            /*
                Columna opcional "Etiqueta Corta" — nombre a usar en la fila
                dinámica "Traducciones + ..." del comparativo del PDF (ver
                pdf.js#buildAdicionalesLabel). Si la fila no la trae (o el
                servicio es nuevo y todavía no se configuró), cae al nombre
                completo de "Servicio" — así un servicio nuevo SIEMPRE queda
                mapeado automáticamente sin tocar código, y el texto corto
                es solo un ajuste opcional de presentación.
            */
            shortLabel: String(row["Etiqueta Corta"] || row["Servicio"]).trim()

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

    // La hoja usa coma como separador decimal (ej. "$709,80") — se
    // convierte a punto ANTES de descartar el resto de símbolos, o
    // "709,80" quedaría como 70980 en vez de 709.80.
    const cleaned = String(value).replace(",", ".").replace(/[^0-9.-]/g, "");

    return Number(cleaned) || 0;

}

async function fetchSecondApplicationSurcharge() {

    const value = await fetchParameter("Recargo tercera aplicación visa (solo onshore)");

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
