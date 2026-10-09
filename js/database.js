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
 - Los descuentos viven directo en "Cursos" vía "Indicador de
   descuento"/"valor descuento", evaluados por
   buildCourseDiscountEffect() más abajo — ya no existe una hoja
   "Promociones" separada. Ver esa sección para el detalle de
   valores soportados.
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

        const [colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, parametrosRows, primerDepositoOnshore] = await Promise.all([

            fetchSheetTab(SHEET_TABS.COLEGIOS),

            fetchSheetTab(SHEET_TABS.CURSOS),

            fetchSheetTab(SHEET_TABS.VISAS),

            fetchSheetTab(SHEET_TABS.SEGUROS),

            fetchSheetTab(SHEET_TABS.COSTOS_FIJOS),

            fetchSheetTab(SHEET_TABS.SERVICIOS_OPCIONALES),

            fetchSheetTab(SHEET_TABS.PARAMETROS, { forceStringColumns: true }),

            fetchSheetTab(SHEET_TABS.PRIMER_DEPOSITO_ONSHORE)

        ]);

        const parametros = {};

        parametrosRows.forEach(row => {

            const key = row["Párametro"] ?? row["Parámetro"];

            if (key) parametros[normalize(key)] = row["valor"];

        });

        sheetsCache = { colegios, cursos, visas, seguros, costosFijos, serviciosOpcionales, parametros, primerDepositoOnshore };

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

    const collegeRows = cursos.filter(row => isRowActive(row) && normalize(row["Colegio"]) === normalize(collegeName));

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

    cursos.filter(isRowActive).forEach(row => {

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
            isRowActive(row) &&
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
            isRowActive(row) &&
            normalize(row["Colegio"]) === normalize(college) &&
            matchesCityFilter(row, city) &&
            normalizeCourseType(row["Tipo Curso"]) === type
        )

        .map(row => row["Programa"])

        .filter(Boolean);

    return [...new Set(programs)];

}

/*==========================================================
 DURACIONES FIJAS ELICOS (cascada: aparece después de Programa)
 ----------------------------------------------------------
 Devuelve los paquetes de duración (columna "Duración") que de
 verdad existen para ese Colegio+Ciudad+Programa, ordenados de
 menor a mayor semana — nunca una lista fija en código (decisión
 confirmada del cliente): cada colegio puede tener sus propios
 paquetes (ej. 12/20/25/40, u otro conjunto distinto) sin tocar
 código, solo cargando filas nuevas en "Cursos". Si el programa no
 tiene ninguna fila con "Duración" poblada, el selector queda
 vacío — ya no existe un comodín de "cualquier duración" para
 ELICOS (ver matchesElicosDuration más arriba).
==========================================================*/

async function fetchElicosDurationsByCourseSelection({ college, city, program }) {

    const { cursos } = await loadAllSheetsData();

    const weeksValues = cursos

        .filter(row =>
            isRowActive(row) &&
            normalize(row["Colegio"]) === normalize(college) &&
            matchesCityFilter(row, city) &&
            normalizeCourseType(row["Tipo Curso"]) === "ELICOS" &&
            normalize(row["Programa"]) === normalize(program)
        )

        .map(row => Number(row["Duración"]))

        .filter(value => !Number.isNaN(value) && value > 0);

    return [...new Set(weeksValues)].sort((a, b) => a - b);

}



/*==========================================================
 INFORMACIÓN COMPLETA DE UN CURSO
 ----------------------------------------------------------
 La duración SIEMPRE viene de la columna "Duración" de la fila ya
 resuelta (decisión confirmada del cliente — unifica ELICOS con
 VET/HE, ya no hay semanas libres):

   - ELICOS: puede haber varias filas por Colegio+Ciudad+Programa,
     una por paquete de duración fija (ver
     fetchElicosDurationsByCourseSelection/matchesElicosDuration);
     la asesora elige el paquete en un selector y ese valor ("weeks")
     entra como criterio de búsqueda en resolveCourseRow — por eso
     "weeks" también se usa para encontrar la fila, no solo para leer
     su resultado.
   - VET / HE: sigue igual que siempre — una sola fila fija por
     Colegio+Ciudad+Programa, "weeks" no participa en la búsqueda.
==========================================================*/

/*==========================================================
 DESCUENTOS POR CURSO
 ----------------------------------------------------------
 Reemplaza por completo el Motor de Promociones y la hoja
 "Promociones" (decisión confirmada del cliente — ya no coexisten).
 Ahora el descuento vive directo en la hoja "Cursos", 2 columnas
 nuevas por fila: "Indicador de descuento" (qué tipo de beneficio)
 y "valor descuento" (cuánto — el encabezado real de la hoja NO
 lleva "de" ni mayúscula inicial; verificado vía gviz, columna U).
 Como cada curso trae UN solo
 indicador (no una lista de reglas), ya no hace falta resolver
 prioridad/combinabilidad entre varias — ver
 buildCourseDiscountEffect más abajo.
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

/*
    "Indicador de descuento" (Cursos) + "valor descuento" ->
    traduce esas 2 columnas a un efecto concreto sobre el precio de
    ESTE curso. Un solo indicador por fila, así que no hay que
    resolver conflictos entre varias reglas (a diferencia del viejo
    Motor de Promociones).

    Los indicadores que mencionan Onshore/Offshore SOLO tienen efecto
    si la cotización es exactamente de ese tipo — en cualquier otro
    caso (incluida una aplicación que no calce) se comportan igual
    que "No aplica" (effect "vacío", sin modificar nada).

    "Nota fija" (decisión confirmada del cliente, 2026-10-05): para
    colegios donde la tarifa semanal YA viene rebajada directo en las
    columnas de catálogo "Valor semana ..." (ver resolveWeeklyRate) —
    sin pasar por "Valor Semana Onshore/Offshore" ni ningún otro
    indicador de precio — este indicador sirve solo para AVISAR al
    estudiante que esa tarifa tiene un precio regular más alto. "valor
    descuento" en esta fila deja de ser el monto del beneficio y pasa a
    ser el precio regular/antes ("antes $300"); el "ahora" nunca se
    escribe a mano — sale de catalogWeeklyRate, la tarifa YA resuelta
    para el bloque exacto de esta fila (ciudad/nacionalidad/horario/
    onshore-offshore/duración, ver resolveWeeklyRate), para que el
    número que ve el estudiante sea siempre el real de la base de
    datos y nunca quede desincronizado si el precio cambia después.
    Sin efecto en precio/semanas/seguro/visa — es 100% informativo
    (bonusDescription), igual que Seguro/Visa Gratis. Si el precio
    regular ingresado es igual o menor al de catálogo (o viene vacío),
    no se genera nota — no hay nada que avisar.

    No hay fecha de vigencia ni prioridad/combinabilidad como en el
    viejo motor (decisión confirmada del cliente: el indicador se
    aplica siempre que esté puesto, hasta que alguien lo cambie a
    mano en la hoja — no hay apagado automático por fecha).
*/
function buildCourseDiscountEffect(row, applicationType, catalogWeeklyRate) {

    const indicator = stripAccents(normalize(row["Indicador de descuento"]));

    const value = Number(row["valor descuento"]) || 0;

    const effect = {

        weeklyRateOverride: null,

        chargeableWeeksDelta: 0,

        percentOff: 0,

        waiveEnrollment: false,

        waiveMaterials: false,

        waiveInsurance: false,

        waiveVisa: false,

        // Descuento real con cifra (Beneficio/Precio final en el PDF,
        // ver pdf.js#buildPromotionBlock) — null = no se muestra nada.
        description: null,

        // true = "description" reemplaza el texto fijo "Beneficio" de la
        // fila de la cifra en rojo (sin línea italic aparte duplicada) —
        // decisión confirmada del cliente para Matrícula/Materiales
        // Gratis y Descuento%, 2026-10-05. false (default) = layout
        // viejo, con la descripción en una línea aparte arriba de
        // "Beneficio" (Resta Semana/Valor Semana, sin cambios).
        mergeBenefitLabel: false,

        // Bono informativo sin cifra (fila "+ nota" en el PDF) — null =
        // no se muestra nada.
        bonusDescription: null

    };

    const onshoreOnly = ["suma semana onshore", "resta semana onshore", "valor semana onshore"];

    const offshoreOnly = ["suma semana offshore", "resta semana offshore", "valor semana offshore"];

    if (onshoreOnly.includes(indicator) && applicationType !== "Onshore") return effect;

    if (offshoreOnly.includes(indicator) && applicationType !== "Offshore") return effect;

    switch (indicator) {

        case "suma semana onshore":
        case "suma semana offshore":
            // Informativo: el estudiante estudia más semanas de las que
            // paga, pero NUNCA afecta precio/semanas pagadas/seguro/visa
            // (decisión confirmada del cliente, 2026-10-05 — mismo
            // principio que el viejo SEMANAS_GRATIS informativo).
            effect.bonusDescription = `Tienes ${value} semana(s) más de estudio`;
            break;

        case "resta semana onshore":
        case "resta semana offshore":
            effect.chargeableWeeksDelta = -value;
            effect.description = `${value} semana(s) de descuento`;
            break;

        case "valor semana onshore":
        case "valor semana offshore":
            effect.weeklyRateOverride = value;
            effect.description = `Precio especial por semana: $${value}`;
            break;

        case "matricula gratis":
            effect.waiveEnrollment = true;
            effect.description = "Beneficio matrícula gratis";
            effect.mergeBenefitLabel = true;
            break;

        case "materiales gratis":
            effect.waiveMaterials = true;
            effect.description = "Beneficio materiales gratis";
            effect.mergeBenefitLabel = true;
            break;

        case "seguro gratis":
            // No toca "discount" (el beneficio real se ve aparte, en
            // Seguro médico = $0 — ver pricing.js#calculateOptionQuote),
            // así que la nota viaja por bonusDescription (como "Suma
            // Semana") para que igual aparezca en el PDF.
            effect.waiveInsurance = true;
            effect.bonusDescription = "Beneficio seguro gratis";
            break;

        case "visa gratis":
            effect.waiveVisa = true;
            effect.bonusDescription = "Beneficio visa gratis";
            break;

        case "descuento":
            effect.percentOff = value;
            effect.description = `Beneficio ${value}% de descuento en tu curso`;
            effect.mergeBenefitLabel = true;
            break;

        case "nota fija": {
            const regularRate = value;
            if (regularRate > 0 && catalogWeeklyRate > 0 && regularRate > catalogWeeklyRate) {
                effect.bonusDescription = `Antes $${regularRate}/semana, ahora $${catalogWeeklyRate}/semana`;
            }
            break;
        }

        // "no aplica" y cualquier valor vacío o no reconocido: sin
        // efecto, el "effect" vacío de arriba ya cubre ese caso.

    }

    return effect;

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
    Decisión confirmada del cliente (2026-10-05): la hoja llena esta
    columna con PAÍS ("España", "Chile") o CONTINENTE ("LATAM", "Europa"),
    nunca con el gentilicio que la asesora selecciona en el formulario
    ("Española", "Chilena") — son textos distintos y antes el motor
    comparaba por gentilicio, así que una celda "España" nunca calzaba
    con una estudiante española. El gentilicio se sigue capturando en el
    formulario (se muestra en PDF/GHL vía quote.student.nationality),
    pero YA NO se usa tal cual para buscar.

    El "country" que recibe esta función y resolveCourseRow() NO es el
    país de residencia del estudiante (student.country) — es el país de
    NACIONALIDAD ya derivado del gentilicio (ver
    countries.js#resolveNationalitySearchCountry, resuelto en
    pricing.js#calculateOptionQuote antes de llegar aquí). Esto importa
    porque residencia y nacionalidad pueden diferir (una estudiante puede
    residir en Colombia y ser de nacionalidad española): usar residencia
    habría hecho calzar su fila con "Colombia"/"LATAM" en vez de con
    "España"/"Europa". Dos niveles de prioridad (más la universal):

      1. Coincidencia EXACTA de país (ej. "España") — admite listas
         separadas por coma en la celda (reutiliza criterionMatches, ver
         más abajo), ej. "LATAM,España" calza con cualquier país de LATAM
         O con España específicamente.
      2. Coincidencia de continente (LATAM/Europa/Asia/África), resuelto
         del mismo país (ver countries.js#resolveContinentForCountry) —
         comodín más amplio cuando la celda no menciona el país exacto.
      3. Fila con "Nacionalidad" vacía = aplica a cualquier estudiante.

    Una fila con "Nacionalidad" vacía SIEMPRE se trata como universal,
    nunca como criterio de continente/país — por eso cada verificación
    exige primero que la celda no esté vacía.
*/
function resolveCourseRowByNationality(candidates, country) {

    const exactMatch = candidates.find(r => {
        const cell = String(r["Nacionalidad"] || "").trim();
        return cell !== "" && criterionMatches(cell, country);
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
    DURACIÓN FIJA ELICOS (decisión confirmada del cliente — reemplaza
    al "Rango de duración"/Semanas desde-hasta): ya no existen rangos ni
    semanas libres para ELICOS. Cada fila declara UN paquete con
    duración exacta en la misma columna "Duración" que ya usan VET/HE
    (unifica el esquema: "Duración" siempre es un valor fijo, sea cual
    sea el Tipo de Curso). Puede haber varias filas para el mismo
    Colegio+Ciudad+Programa, una por paquete (ej. 12/20/25/40 semanas),
    cada una con su propio precio — la asesora elige el paquete en un
    selector (ver fetchElicosDurationsByCourseSelection más abajo y
    courses.js), nunca escribe la semana a mano.

    Sin comodín: una fila ELICOS sin "Duración" no calza con NINGÚN
    paquete (ya no representa "aplica a cualquier duración" como antes
    el rango vacío) — el selector solo ofrece paquetes que sí existan,
    así que en la práctica la asesora nunca puede pedir una duración
    sin fila correspondiente.

    VET/HE no pasan por aquí (matchesElicosDuration devuelve true de
    inmediato): su duración sigue siendo la única fija de la fila,
    nunca elegida por la asesora.
*/
function matchesElicosDuration(row, type, weeks) {

    if (type !== "ELICOS") return true;

    const rowWeeks = row["Duración"];

    if (rowWeeks === "" || rowWeeks === null || rowWeeks === undefined) return false;

    return Number(rowWeeks) === Number(weeks);

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
function resolveCourseRow(cursos, { college, city, type, program, country, weeks }) {

    const baseCandidates = cursos.filter(r =>
        isRowActive(r) &&
        normalize(r["Colegio"]) === normalize(college) &&
        normalizeCourseType(r["Tipo Curso"]) === type &&
        normalize(r["Programa"]) === normalize(program) &&
        matchesElicosDuration(r, type, weeks)
    );

    if (baseCandidates.length === 0) return null;

    const cityCandidates = baseCandidates.filter(r =>
        splitCityValues(r["Ciudad"]).some(value => normalize(value) === normalize(city))
    );

    const cityMatch = resolveCourseRowByNationality(cityCandidates, country);

    if (cityMatch) return cityMatch;

    const anyCityCandidates = baseCandidates.filter(r => splitCityValues(r["Ciudad"]).length === 0);

    return resolveCourseRowByNationality(anyCityCandidates, country);

}

async function fetchCourseDetails({ college, city, type, program, weeks, schedule, country, applicationType }) {

    const { cursos } = await loadAllSheetsData();

    const row = resolveCourseRow(cursos, { college, city, type, program, country, weeks });

    if (!row) {

        return {

            found: false,

            // Ver fetchCourseDetails más abajo (caso "found: true") — aquí
            // directamente no hay fila, así que ya existe el warning
            // "no se encontró esa combinación exacta" (pricing.js#collectWarnings);
            // no hace falta duplicar el aviso.
            weeklyRateMissing: false,

            price: 0,

            enrollmentFee: 0,

            materialsFee: 0,

            officialWeeks: Number(weeks) || 0,

            discount: 0,

            discountSource: null,

            discountMergeLabel: false,

            bonusNotes: [],

            priceDiscount: 0,

            enrollmentFeeWaivedAmount: 0,

            materialsFeeWaivedAmount: 0,

            onshoreWeeklyRate: 0,

            waiveInsurance: false,

            waiveVisa: false

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

    const materialsFeeBeforeCap = isMaterialsPerWeek ? materialsRaw * officialWeeks : materialsRaw;

    /*
        TOPE DE MATERIALES (columna "condicion materiales" — encabezado
        real verificado en la hoja, 2026-10-09): algunos colegios (ej.
        ILSC=450, Insight Academy=360) no cobran más de un monto fijo de
        materiales sin importar cuánto sume el cálculo normal —
        típicamente con "Indicador de Materiales"="Por semana", donde sin
        tope el monto crece sin límite en cursos largos. Si la celda trae
        un número > 0, se usa como techo (Math.min); vacía o 0 = sin tope,
        comportamiento de siempre.
    */
    const materialsCap = Number(row["condicion materiales"]) || 0;

    const catalogMaterialsFee = materialsCap > 0 ? Math.min(materialsFeeBeforeCap, materialsCap) : materialsFeeBeforeCap;

    const catalogPrice = catalogWeeklyRate * officialWeeks;

    const catalogTotal = catalogPrice + catalogEnrollmentFee + catalogMaterialsFee;

    const discountEffect = buildCourseDiscountEffect(row, applicationType, catalogWeeklyRate);

    const weeklyRate = discountEffect.weeklyRateOverride != null ? discountEffect.weeklyRateOverride : catalogWeeklyRate;

    // "Resta Semana" resta de las semanas PAGADAS, nunca de officialWeeks
    // (la duración real de estudio sigue sin tocarse para Visa/Seguro/
    // umbral de 25 semanas — mismo principio ya confirmado con Aussie
    // English bajo el viejo motor). "Suma Semana" es puramente
    // informativo (bonusDescription) y NO toca chargeableWeeks ni
    // officialWeeks (decisión confirmada del cliente, 2026-10-05).
    const chargeableWeeks = Math.max(0, officialWeeks + discountEffect.chargeableWeeksDelta);

    let programPrice = weeklyRate * chargeableWeeks;

    programPrice = programPrice * (1 - Math.min(discountEffect.percentOff, 100) / 100);

    const finalEnrollmentFee = discountEffect.waiveEnrollment ? 0 : catalogEnrollmentFee;

    const finalMaterialsFee = discountEffect.waiveMaterials ? 0 : catalogMaterialsFee;

    const finalTotal = programPrice + finalEnrollmentFee + finalMaterialsFee;

    // "Descuento" = beneficio real en dólares vs. el precio de catálogo
    // (ya con la tarifa de Horario aplicada) — así "Total Programa" sigue
    // siendo el precio de catálogo (sin descuento) y "Descuento" siempre
    // es la diferencia, sin duplicar ni recalcular nada aparte (ver
    // pricing.js#assembleTotals).
    const discount = Math.max(0, catalogTotal - finalTotal);

    const discountSource = discount > 0 ? discountEffect.description : null;

    // Bono informativo ("Suma Semana") — nunca afecta precio/descuento,
    // solo se muestra como nota aparte en el PDF (ver pdf.js#buildPromotionBlock).
    const bonusNotes = discountEffect.bonusDescription ? [discountEffect.bonusDescription] : [];

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

    const enrollmentFeeWaivedAmount = discountEffect.waiveEnrollment ? catalogEnrollmentFee : 0;

    const materialsFeeWaivedAmount = discountEffect.waiveMaterials ? catalogMaterialsFee : 0;

    return {

        found: true,

        // Fila encontrada (Colegio+Ciudad+Programa+Nacionalidad+Duración
        // calzan), pero sin ninguna tarifa semanal utilizable: ni la del
        // Horario elegido, ni el respaldo general del bloque Onshore/
        // Offshore (resolveWeeklyRate), ni un "Valor Semana Onshore/
        // Offshore" que la reemplace. Antes esto producía una cotización
        // silenciosa en $0 — ahora pricing.js#collectWarnings avisa ANTES
        // de generar, en vez de dejar pasar un curso sin precio (pedido
        // explícito del cliente, 2026-10-05).
        weeklyRateMissing: weeklyRate <= 0,

        price: catalogPrice,

        enrollmentFee: catalogEnrollmentFee,

        materialsFee: catalogMaterialsFee,

        officialWeeks,

        discount,

        discountSource,

        // Ver buildCourseDiscountEffect#mergeBenefitLabel y
        // pdf.js#buildPromotionBlock — cómo mostrar discountSource junto
        // a la cifra de "discount" en el PDF.
        discountMergeLabel: discountEffect.mergeBenefitLabel,

        bonusNotes,

        priceDiscount,

        enrollmentFeeWaivedAmount,

        materialsFeeWaivedAmount,

        // "Seguro Gratis"/"Visa Gratis" (ver buildCourseDiscountEffect) —
        // el Seguro médico y la Visa se calculan UNA vez por opción, no
        // por curso (ver pricing.js#calculateInsurance/calculateVisa), así
        // que esta bandera solo viaja hasta allá: si CUALQUIER curso de la
        // opción la trae en true, pricing.js#calculateOptionQuote pone ese
        // costo en $0 para toda la opción.
        waiveInsurance: discountEffect.waiveInsurance,

        waiveVisa: discountEffect.waiveVisa,

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
 (eliminada) — ahora la condición vive en su propia pestaña
 (Colegio, Tipo de condición, Parámetro, condición extra), para
 poder ajustarla sin tocar código. Solo aplica a Onshore.

 Tipos de condición soportados hoy:
   - "Valor fijo": el depósito ES directamente el Parámetro, sin
     sumar nada más — ni Matrícula ni Materiales.
   - "Valor + Matricula + Materiales": el depósito = Parámetro +
     Matrícula + Materiales del curso.
   - "Semanas de estudio + Matricula + Materiales" (también se
     acepta la forma vieja, sin el sufijo, por compatibilidad): el
     Parámetro es un número de semanas; depósito = (tarifa semanal
     Onshore cotizada × ese número) + Matrícula + Materiales.
   - "Tiempo + Matricula + Materiales" (decisión confirmada del
     cliente, 2026-10-09 — ej. Impact College): el Parámetro es un
     PORCENTAJE que aplica SOLO al curso; depósito = (Parámetro% ×
     Curso) + Matrícula + Materiales (estas 2 últimas COMPLETAS,
     nunca prorrateadas). Único tipo que admite VARIAS filas para
     el mismo Colegio — un tramo de "condición extra" por fila (ver
     más abajo), porque el porcentaje cambia según la duración real del
     curso cotizado.

 "condición extra" (columna D, solo la usa "Tiempo + Matricula +
 Materiales" hoy, aunque cualquier tipo podría tenerla si en el
 futuro hiciera falta un tramo): decide CUÁL fila aplica cuando un
 Colegio tiene más de una. Formatos aceptados (texto libre en la
 celda, ver parseExtraConditionRange):
   - "16-23"  -> aplica si la Duración del curso está entre 16 y 23
                 (ambos inclusive).
   - "30"     -> un solo número = "30 o más" (sin tope superior).
   - vacía    -> comodín, aplica a cualquier Duración (es el caso de
                 TODOS los colegios con una sola fila, como siempre).
 Si un Colegio tiene varias filas, se usa la PRIMERA cuyo rango
 calce con la Duración real del curso — si ninguna calza, se trata
 como "no reconocido" (ver más abajo), igual que un Tipo de
 condición vacío: nunca se inventa un porcentaje.

 Cualquier "Tipo de condición" vacío, que no calce EXACTO con uno
 de los textos de arriba, o cuya "condición extra" no cubra la
 Duración real del curso, se trata como "no reconocido"
 (recognized:false) — pricing.js#applyOnshoreFirstPaymentDeposits
 lo marca igual que "colegio sin fila" (firstPaymentDepositMissing
 = true), para que collectWarnings() avise y bloquee ANTES de
 generar, en vez de mostrar $0 de base en silencio (decisión
 confirmada del cliente: nunca más un depósito incompleto sin
 aviso).

 Matrícula/Materiales/Curso que se usan en el cálculo son los YA
 RESUELTOS de ese curso (netos de la regla de matrícula única por
 colegio, de cualquier promoción de matrícula/materiales gratis, y
 del descuento de precio del curso si lo tuviera) — por eso el
 armado final del depósito no puede vivir aquí: se ejecuta en
 pricing.js DESPUÉS de applyInstitutionEnrollmentFeeRule(), cuando
 esos valores ya son definitivos.
*/

const ONSHORE_DEPOSIT_CONDITION_TYPES = {

    VALOR_FIJO: normalize("Valor fijo"),

    VALOR_MAS_FEES: normalize("Valor + Matricula + Materiales"),

    SEMANAS_MAS_FEES: normalize("Semanas de estudio + Matricula + Materiales"),

    // Alias legado: antes de este cambio, este era el ÚNICO texto para el
    // cálculo por semanas (sin el sufijo "+ Matricula + Materiales”) — se
    // sigue aceptando para no romper ninguna fila que no se haya migrado.
    SEMANAS_LEGACY: normalize("Semanas de estudio"),

    PORCENTAJE_POR_DURACION: normalize("Tiempo + Matricula + Materiales")

};

/*
    Sentinela INTERNO (nunca un texto que se escriba en el Sheet) — ver
    fetchOnshoreDepositCondition/computeOnshoreDeposit más abajo: marca el
    caso "ningún tramo de condición extra cubre esta Duración", que cobra
    el 100% en vez de bloquear.
*/
const NO_BRACKET_MATCH_SENTINEL = "__sin_tramo_cobra_100__";

/*
    Interpreta el texto libre de "condición extra" — ver cabecera de esta
    sección para los formatos aceptados. Devuelve null si la celda está
    vacía (comodín, aplica siempre) o si el texto no calza ningún formato
    reconocido (en ese caso matchesExtraCondition() lo trata como "no
    aplica", nunca como comodín, para no aplicar un tramo mal escrito por
    accidente).
*/
function parseExtraConditionRange(rawExtraCondition) {

    const raw = String(rawExtraCondition == null ? "" : rawExtraCondition).trim();

    if (raw === "") return { wildcard: true };

    const rangeMatch = raw.match(/^(\d+)\s*-\s*(\d+)$/);

    if (rangeMatch) return { wildcard: false, min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };

    const single = Number(raw);

    if (!Number.isNaN(single)) return { wildcard: false, min: single, max: Infinity };

    return null;

}

function matchesExtraCondition(rawExtraCondition, officialWeeks) {

    const range = parseExtraConditionRange(rawExtraCondition);

    if (!range) return false;

    if (range.wildcard) return true;

    return officialWeeks >= range.min && officialWeeks <= range.max;

}

async function fetchOnshoreDepositCondition(college, officialWeeks) {

    const { primerDepositoOnshore } = await loadAllSheetsData();

    const candidates = primerDepositoOnshore.filter(r => normalize(r["Colegio"]) === normalize(college));

    if (candidates.length === 0) return { found: false, recognized: false, tipo: "", parametro: 0 };

    // La mayoría de colegios tiene UNA sola fila con "condición extra"
    // vacía (comodín, calza siempre) — los que tienen varias (ej. Impact
    // College) dependen de que la Duración real del curso caiga en el
    // tramo correcto.
    const row = candidates.find(r => matchesExtraCondition(r["condición extra"], officialWeeks));

    /*
        Ningún tramo cubre esta Duración (ej. Impact College con un curso
        de 10 o 12 semanas, fuera de 16-23/24-29/30+) — decisión
        confirmada del cliente, 2026-10-09: en ese caso el Primer Pago NO
        se bloquea ni avisa (no es un dato faltante) — se cobra el 100%
        del curso (neto de cualquier descuento real) + Matrícula +
        Materiales, exactamente el "Total Programa" de ese curso, sin
        ningún descuento de depósito. Ver NO_BRACKET_MATCH_SENTINEL /
        computeOnshoreDeposit más abajo.
    */
    if (!row) return { found: true, recognized: true, tipo: NO_BRACKET_MATCH_SENTINEL, parametro: 0 };

    const tipo = normalize(row["Tipo de condición"]);

    const recognized = Object.values(ONSHORE_DEPOSIT_CONDITION_TYPES).includes(tipo);

    return {

        found: true,

        recognized,

        tipo,

        parametro: Number(row["Parámetro"]) || 0

    };

}

/*
    Calcula el depósito final directamente (ya no un "base" +
    "includesFees" separados — el tipo por porcentaje necesita el precio
    del curso además de Matrícula/Materiales, así que cada rama arma su
    propio total). "price"/"priceDiscount"/"enrollmentFee"/"materialsFee"
    son los valores YA DEFINITIVOS del curso (ver cabecera de la
    sección) — "price - priceDiscount" es el precio del curso neto de
    cualquier descuento, nunca el de catálogo sin descontar.
*/
function computeOnshoreDeposit(condition, { onshoreWeeklyRate, price, priceDiscount, enrollmentFee, materialsFee }) {

    const T = ONSHORE_DEPOSIT_CONDITION_TYPES;

    // Ningún tramo de "condición extra" cubrió esta Duración — decisión
    // confirmada del cliente, 2026-10-09: se cobra el 100% (el "Total
    // Programa" de ese curso, neto de cualquier descuento real, sin
    // ningún descuento de depósito encima).
    if (condition.tipo === NO_BRACKET_MATCH_SENTINEL) {

        return Math.max(0, price - priceDiscount) + enrollmentFee + materialsFee;

    }

    if (condition.tipo === T.VALOR_FIJO) return condition.parametro;

    if (condition.tipo === T.VALOR_MAS_FEES) return condition.parametro + enrollmentFee + materialsFee;

    if (condition.tipo === T.SEMANAS_MAS_FEES || condition.tipo === T.SEMANAS_LEGACY) {

        return (onshoreWeeklyRate * condition.parametro) + enrollmentFee + materialsFee;

    }

    if (condition.tipo === T.PORCENTAJE_POR_DURACION) {

        // El porcentaje aplica SOLO al curso (decisión confirmada del
        // cliente, 2026-10-09 — corrige una primera versión que lo
        // aplicaba sobre curso+matrícula+materiales juntos). Matrícula y
        // Materiales se suman COMPLETOS encima, igual que en los otros
        // tipos "... + Matricula + Materiales".
        const netCoursePrice = Math.max(0, price - priceDiscount);

        const courseShare = netCoursePrice * (Math.min(condition.parametro, 100) / 100);

        return courseShare + enrollmentFee + materialsFee;

    }

    return 0;

}



/*==========================================================
 SEGURO MÉDICO (decisión confirmada del cliente, 2026-10-07)
 ----------------------------------------------------------
 Reemplaza el cálculo "valor semanal × semanas" — igual que los
 cursos, la hoja "Seguros" ahora trae una fila por cada plan +
 duración exacta (columnas "seguro", "Duración"), con
 "Single"/"Couple"/"Family" como el MONTO TOTAL YA RESUELTO para
 esa duración (nunca un valor por semana) — se lee directo, sin
 ningún cálculo (ver pricing.js#calculateInsurance). La columna
 "vacaciones" es solo referencia para quien carga la hoja (cuántas
 semanas de gracia ya vienen incluidas en ese monto); el código
 nunca la usa.

 Búsqueda por COINCIDENCIA EXACTA de (seguro, Duración = semanas
 totales de la cotización) — sin redondeo ni extrapolación: si no
 existe una fila para esa duración exacta, se trata como "no
 encontrado" (found:false), igual que cualquier otro dato faltante
 — bloquea "Generar Cotización" en vez de inventar un número
 (collectWarnings ya tiene el aviso para este caso). La regla de
 qué hacer cuando la duración no calza exacto (¿tomar la más
 cercana? ¿cuál redondeo?) queda PENDIENTE de definir con el
 cliente — por ahora es estrictamente "exacto o nada".
==========================================================*/

async function fetchInsuranceOptions() {

    const { seguros } = await loadAllSheetsData();

    const names = seguros

        .map(row => String(row["seguro"] || "").trim())

        .filter(Boolean);

    return [...new Set(names)];

}

async function fetchInsuranceCost({ insuranceName, quotationType, totalWeeks }) {

    const { seguros } = await loadAllSheetsData();

    const row = seguros.find(r =>
        normalize(r["seguro"]) === normalize(insuranceName) &&
        Number(r["Duración"]) === Number(totalWeeks)
    );

    if (!row || !Object.prototype.hasOwnProperty.call(row, quotationType)) {

        return { amount: 0, found: false };

    }

    return { amount: Number(row[quotationType]) || 0, found: true };

}



/*==========================================================
 VISA (decisión confirmada del cliente, 2026-10-09)
 ----------------------------------------------------------
 Ya NO se cobra "tarifa × número de aplicantes" — la hoja "Visas"
 ahora trae 3 columnas por fila (Destino + Tipo de curso, igual
 jerarquía de siempre vía COURSE_TYPE_PRIORITY):
   - "Valor visa"            -> el aplicante principal (Single)
   - "Visa Couple"           -> SE SUMA si el Tipo de Cotización
                                es Couple o Family (la pareja)
   - "Visa menor de edad"    -> SE SUMA × cantidad de menores,
                                SOLO si el Tipo de Cotización es
                                Family
 "Visa Couple"/"Visa menor de edad" pueden venir vacías (ej. fila
 de España) — se tratan como 0, nunca rompen el cálculo.
==========================================================*/

async function fetchVisaCost({ destination, courseTypes, quotationType, numberOfMinors }) {

    const { visas } = await loadAllSheetsData();

    const primaryType = COURSE_TYPE_PRIORITY.find(type => courseTypes.includes(type)) || null;

    const empty = { singleRate: 0, coupleRate: 0, minorRate: 0, numberOfMinors: 0, primaryType: null, found: false };

    if (!primaryType) return empty;

    const row = visas.find(r =>
        normalize(r["Destino"]) === normalize(destination) &&
        normalizeCourseType(r["Tipo de curso"]) === primaryType
    );

    if (!row) return { ...empty, primaryType };

    const singleRate = Number(row["Valor visa"]) || 0;

    const coupleRate = Number(row["Visa Couple"]) || 0;

    const minorRate = Number(row["Visa menor de edad"]) || 0;

    const minors = normalize(quotationType) === normalize("Family") ? Math.max(0, Number(numberOfMinors) || 0) : 0;

    return { singleRate, coupleRate, minorRate, numberOfMinors: minors, primaryType, found: true };

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
 ----------------------------------------------------------
 AIRPORT PICKUP (decisión confirmada del cliente, 2026-10-07):
 la hoja sigue trayendo una fila POR CIUDAD ("Airport Pickup
 Sydney", "Airport Pickup Melbourne", etc. — columna "Servicio"),
 pero ya no se muestran como checkboxes separados: fetchServiceCatalog()
 las saca del catálogo plano y expone un único servicio sintético
 "Airport Pickup" (AIRPORT_PICKUP_CODE) en su lugar. El precio real
 por ciudad se resuelve aparte con fetchAirportPickupRate() — ver
 pricing.js#calculateServicesLines para el dónde y el cómo (el
 cotizador compara TODAS las ciudades de estudio de TODAS las
 opciones de colegio y usa la más cara, igual que cualquier otro
 servicio "compartido" — ver esa función para el detalle completo).

 SIM CARD (decisión confirmada del cliente, 2026-10-09): deja de
 ser un checkbox propio — siempre que se seleccione Airport Pickup,
 se regala gratis junto con la recogida (pricing.js#calculateServicesLines
 agrega "+ SIM Card" al nombre de esa línea, sin cobrar nada aparte).
 La fila "SIM Card" de la hoja se mantiene (por si se vuelve a vender
 sola en el futuro) pero fetchServiceCatalog() ya no la expone como
 opción seleccionable.
==========================================================*/

const AIRPORT_PICKUP_PREFIX = "Airport Pickup";

const AIRPORT_PICKUP_CODE = "airport-pickup";

const SIM_CARD_SERVICE_NAME = "SIM Card";

async function fetchServiceCatalog() {

    const { serviciosOpcionales } = await loadAllSheetsData();

    const rows = serviciosOpcionales.filter(row => row["Servicio"]);

    const firstAirportPickupIndex = rows.findIndex(row =>
        normalize(row["Servicio"]).startsWith(normalize(AIRPORT_PICKUP_PREFIX))
    );

    const catalog = rows

        .filter(row =>
            !normalize(row["Servicio"]).startsWith(normalize(AIRPORT_PICKUP_PREFIX)) &&
            normalize(row["Servicio"]) !== normalize(SIM_CARD_SERVICE_NAME)
        )

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

    if (firstAirportPickupIndex === -1) return catalog;

    // unitCost/shortLabel quedan en 0/genérico a propósito: el precio real
    // (dependiente de ciudad) lo resuelve pricing.js#calculateServicesLines
    // vía fetchAirportPickupRate(), nunca este catálogo plano.
    const airportPickupEntry = {

        code: AIRPORT_PICKUP_CODE,

        label: AIRPORT_PICKUP_PREFIX,

        unitCost: 0,

        shortLabel: AIRPORT_PICKUP_PREFIX

    };

    // Se inserta donde estaba la primera fila "Airport Pickup <Ciudad>" en
    // la hoja, para que el orden visual del listado de servicios no
    // cambie demasiado respecto a lo que ya conoce la asesora.
    const insertAt = Math.min(firstAirportPickupIndex, catalog.length);

    catalog.splice(insertAt, 0, airportPickupEntry);

    return catalog;

}

/*
    Precio real de Airport Pickup para UNA ciudad concreta — busca la fila
    "Airport Pickup <Ciudad>" exacta (ignora acentos/mayúsculas). Si esa
    ciudad no tiene fila propia, se trata como "no disponible" (found:false)
    — nunca cae a un valor genérico, porque hoy el precio SIEMPRE varía
    por ciudad (no existe una fila "Airport Pickup" sin ciudad).
*/
async function fetchAirportPickupRate(city) {

    const { serviciosOpcionales } = await loadAllSheetsData();

    const target = normalize(`${AIRPORT_PICKUP_PREFIX} ${city}`);

    const row = serviciosOpcionales.find(r => normalize(r["Servicio"]) === target);

    if (!row) return { amount: 0, found: false };

    return { amount: Number(row["Precio"]) || 0, found: true };

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
