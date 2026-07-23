/*==========================================================
 LATINADVISOR
 PDF MODULE
 VERSION 4.0 — COMPARATIVO DE OPCIONES DE COLEGIO
 ----------------------------------------------------------
 La página de detalle (assets/img/pagina-blanca-cotizacion.pdf)
 trae el diseño completo (logo, título, acento, encabezado
 "Detalles del programa:" y los dos cuadros verdes "Estudio
 por"/"Asesora"). Este módulo arma un documento pdfmake que
 contiene ÚNICAMENTE el contenido dinámico —los valores de esos
 cuadros, el detalle del programa, la tabla de costos, el
 resumen y las notas— posicionado exactamente sobre las
 coordenadas de esa plantilla, y lo estampa encima con pdf-lib
 (page.drawPage sobre un form XObject embebido).

 Con varias opciones de colegio (pestañas, ver
 pricing.js#calculateQuotation / js/course-options.js), el PDF
 final queda: portada (por la ciudad del primer curso de la
 primera opción — ver generateQuotationPdfBlob) -> página
 comparativa (assets/img/comparativo.pdf,
 una columna por opción) -> detalle completo de cada opción, en
 orden, cada una empezando de nuevo con pagina-blanca-
 cotizacion.pdf y usando pagina-extra.pdf si su contenido
 desborda una página (ver generateQuotationPdfBlob/
 mergeFinalPdf). El detalle de cada opción reutiliza,
 SIN CAMBIOS, buildOverlayDocDefinition — pricing.js arma para
 cada una un objeto "quote" con la forma legacy de una sola
 opción (buildLegacyOptionQuote) para que esta función no tenga
 que saber que existen pestañas.

 Todas las funciones de construcción de contenido son puras
 (solo arman el docDefinition de pdfmake o listas de filas). Los
 únicos puntos que tocan red son fetchExchangeRate (fx.js) y
 fetchCoverPdfBytes / fetchPage2TemplateBytes / fetchComparativoTemplateBytes (pdf-assets.js).

 "PROGRAMA PRINCIPAL" (por opción): con más de un curso en una
 misma opción, el bloque "Detalles del programa" de ESA opción
 se calcula con su PRIMER curso (decisión confirmada por el
 cliente). Los demás cursos de la opción igual aparecen,
 completos, en su tabla de costos.

 DOBLE MONEDA: cada monto de la tabla tiene su propia columna
 AUD y USD, convertida a la tasa del día (fx.js). Es una
 conversión de PRESENTACIÓN: el monto real de la cotización
 sigue siendo, siempre, el que arma pricing.js en su moneda
 original. Si la tasa no está disponible, la columna USD
 muestra "—" en vez de romper el PDF.

 DESCUENTO: por pedido explícito del cliente, NO aparece en la
 tabla de costos (esa tabla debe reflejar costos reales) — solo
 se muestra en el Resumen Financiero, justo antes del total.

 COSTOS EXTRAS: exámenes médicos y biométricos (quote.extraCosts,
 ver pricing.js). Aparecen SOLO si la cotización es Offshore y
 el país del estudiante (GoHighLevel) está autorizado. Se
 muestran en su propia tabla "COSTOS EXTRAS" (después de
 "DESGLOSE DE COSTOS" y "OTROS CARGOS") y como "Total de Costos
 Extras" diferenciado en el Resumen Financiero — NUNCA se suman
 al TOTAL.
==========================================================*/

const COMPANY_FOOTER = "LatinAdvisor · Asesoría Educativa y Migratoria · www.latinadvisor.com.au";

const DEFAULT_ASESORA_NAME = "María González";

/*==========================================================
 PALETA DE MARCA (tomada del logo oficial, ver assets/img)
==========================================================*/

const PDF_COLORS = {

    navy: "#1c4286",

    green: "#8dcd25",

    greenDark: "#73b61a",

    text: "#2d3436",

    subtitle: "#70757a",

    border: "#d8dde3",

    tableHeaderFill: "#f5f7fa",

    warning: "#92400e"

};

/*==========================================================
 COORDENADAS DE LA PLANTILLA (assets/img/pagina-blanca-cotizacion.pdf)
 ----------------------------------------------------------
 Medidas EXACTAS, no estimadas a ojo sobre un render: se extrajo
 y descomprimió (FlateDecode) el content stream de arte vectorial
 embebido en la propia plantilla y se leyeron ahí las coordenadas
 reales de los dos rectángulos verdes (color #8dcd25 / rgb
 0.580392 0.847059 0.152941, ver el "scn" antes de cada "re"):

   Cuadro "Estudio por": cm [1 0 0 1 329 603] + rect (0,0)-(231,22)
     -> x: 329 a 560, y (PDF, origen abajo): 603 a 625
   Cuadro "Asesora":     cm [1 0 0 1 329 552.967773] + rect (0,0)-(231,21.402557)
     -> x: 329 a 560, y (PDF, origen abajo): 552.97 a 574.37

 Convertido a la convención de pdfmake (absolutePosition: y crece
 hacia abajo desde el borde superior, y_top = pageHeight - y_pdf):

   Cuadro "Estudio por": y_top 167.0 (arriba) a 189.0 (abajo), alto 22
   Cuadro "Asesora":     y_top 217.6 (arriba) a 239.0 (abajo), alto 21.4

 Los valores anteriores (195 y 246) quedaban ambos ~24pt por
 debajo del cuadro real correspondiente — por eso el contenido
 dinámico aparecía flotando en el espacio en blanco DEBAJO de cada
 cuadro verde en vez de centrado dentro de él. Si el diseño de la
 plantilla cambia, hay que repetir esta medición (no adivinar).
==========================================================*/

const TEMPLATE_LAYOUT = {

    pageWidth: 612,

    pageHeight: 792,

    leftMargin: 52,

    rightMargin: 52,

    /*
        greenBoxLeft/Right son los bordes reales del rectángulo verde
        (x: 329 a 560, ver medición arriba) — el contenido dinámico se
        alinea a la derecha DENTRO de ese ancho, igual que
        "ESTUDIO POR:"/"ASESORA:" ya vienen alineados en la propia
        plantilla.
    */

    greenBoxLeft: 329,

    greenBoxRight: 560,

    /*
        Espacio entre el final del texto alineado a la derecha y el
        borde derecho real del cuadro verde (greenBoxRight) — pedido
        explícito del cliente para que no quede pegado al extremo.
    */

    greenBoxRightPadding: 7,

    /*
        "y" de cada cuadro centra verticalmente un texto de 11pt
        bold (~12.65pt de alto de línea) dentro del alto real del
        cuadro: y_top_del_cuadro + (alto_del_cuadro - 12.65) / 2.
        Ver buildGreenBoxValue(): la tabla que dibuja este valor usa
        padding explícito en 0, así que "y" es directamente el borde
        superior del texto, sin relleno oculto que compense.
    */

    estudioPorText: { x: 329, y: 172 },

    asesoraText: { x: 329, y: 222 },

    /*
        La etiqueta "Detalles:" impresa en la propia plantilla tiene su
        baseline en y_top≈163 (medido igual que los cuadros verdes: cm
        [1 0 0 1 52 619.005859] + Tm offset 8.994141 sobre el content
        stream real -> y_pdf=628.0 -> y_top=792-628=163.0).

        "contentStartY" además queda calibrado para que la ÚLTIMA línea
        del bloque ("Correo", ver buildProgramInfoBlock) termine
        alineada con el borde inferior del cuadro verde "Asesora"
        (y_top=239.0, ver asesoraText/medición de cuadros verdes más
        arriba) — pedido explícito del cliente. Con "Opción N —
        Colegio" presente (varias pestañas), el stack de
        buildProgramInfoBlock mide, de arriba a abajo:

          optionLabelLine  fontSize 12, margin [0,0,0,2]  -> 0 + 12*1.15 + 2  = 15.8
          4x infoLine      fontSize  9, margin [0,1,0,1]  -> (1 + 9*1.15 + 1) * 4 = 49.4
                                                              stack total       = 65.2

        contentStartY = 239.0 (borde inferior Asesora) - 65.2 = 173.8 -> 174.

        Nota: sin "Opción N —" (una sola opción de colegio, ver
        buildProgramInfoBlock) el stack tiene 1 línea menos y termina
        ~15.8pt más arriba — el alineado exacto con el cuadro Asesora
        aplica al caso de referencia (varias opciones); igual nunca se
        superpone con nada, solo queda con un poco más de aire debajo.
    */

    contentStartY: 174

};

/*==========================================================
 COORDENADAS DE LA PLANTILLA DEL COMPARATIVO
 (assets/img/comparativo.pdf)
 ----------------------------------------------------------
 "Detalles:" en ESTA plantilla tiene su baseline en y_top≈164
 (cm [1 0 0 1 52 619.005859] + Tm offset 8.994141 sobre el content
 stream real, sin comprimir a diferencia de pagina-blanca-
 cotizacion.pdf — mismo método de medición, mismo resultado:
 prácticamente idéntico al de TEMPLATE_LAYOUT). "contentStartY" ya
 no es una estimación visual.
==========================================================*/

const COMPARATIVO_LAYOUT = {

    leftMargin: 52,

    rightMargin: 52,

    /*
        180pt deja el contenido justo debajo de la etiqueta "Detalles:"
        (baseline en y_top≈164) — antes eran 200pt, un hueco de ~36pt
        que el cliente pidió reducir para que el bloque de detalles
        (Nombre del estudiante/Correo/Fecha) quede más cerca del
        título, igual que en TEMPLATE_LAYOUT.contentStartY.
    */

    contentStartY: 180

};

/*==========================================================
 COORDENADAS DE LA PLANTILLA DE PÁGINA EXTRA
 (assets/img/pagina-extra.pdf)
 ----------------------------------------------------------
 A diferencia de pagina-blanca-cotizacion.pdf y comparativo.pdf,
 esta plantilla SOLO trae el logo arriba a la derecha (sin
 título, acento ni cuadros verdes) — por eso el offset necesario
 para no pisarlo es mucho menor que TEMPLATE_LAYOUT.contentStartY
 / COMPARATIVO_LAYOUT.contentStartY.
 ----------------------------------------------------------
 IMPORTANTE: pdfmake (la versión 0.2.10 que carga index.html) NO
 soporta "pageMargins" como función por página — su
 fixPageMargins() interno solo reconoce un número o un array de
 2/4 posiciones; cualquier otro valor (como una función) lo deja
 pasar tal cual, y el resto del motor termina haciendo
 "pageMargins.top"/".bottom" sobre esa función, lo que da NaN y
 deja el layout paginando en un bucle infinito (el PDF nunca
 termina de generarse). Por eso "contentStartY" se aplica como
 margen superior FIJO en TODAS las páginas del documento (ver
 pageMargins más abajo) y, para que la página 1 quede
 exactamente igual que antes, se resta ese mismo valor del
 margin-top que ya traía el primer bloque de contenido
 (TEMPLATE_LAYOUT.contentStartY / COMPARATIVO_LAYOUT.contentStartY)
 — la suma de ambos da el mismo offset total de 200pt de siempre
 en la página 1, mientras que cualquier página de desborde (que
 no lleva ese bloque) queda con el margen de 110pt reservado,
 suficiente para no pisar el logo.
==========================================================*/

const EXTRA_PAGE_LAYOUT = {

    contentStartY: 110

};

/*==========================================================
 UTILIDADES DE FORMATO
 ----------------------------------------------------------
 formatCurrency() vive en summary.js (se reutiliza tal cual).
==========================================================*/

function formatMoneyCell(amount, currency, { negative = false, alignment = "right" } = {}) {

    const value = Math.abs(Number(amount) || 0);

    const text = (negative ? "- " : "") + formatCurrency(value, currency);

    return { text, alignment, fontSize: 9 };

}

function formatUsdCell(amount, usdRate, { negative = false, alignment = "right" } = {}) {

    if (!usdRate) return { text: "—", alignment, fontSize: 9, color: PDF_COLORS.subtitle };

    const value = Math.abs(Number(amount) || 0) * usdRate;

    const text = (negative ? "- " : "") + formatCurrency(value, "USD");

    return { text, alignment, fontSize: 9, color: PDF_COLORS.subtitle };

}

function amountRow(label, amount, currency, usdRate, options = {}) {

    return [

        { text: label, fontSize: 9, bold: !!options.bold, color: options.bold ? PDF_COLORS.greenDark : PDF_COLORS.text },

        { ...formatMoneyCell(amount, currency, options), bold: !!options.bold, color: options.bold ? PDF_COLORS.greenDark : PDF_COLORS.text, fontSize: options.bold ? 12 : 9 },

        { ...formatUsdCell(amount, usdRate, options), bold: !!options.bold, color: options.bold ? PDF_COLORS.greenDark : PDF_COLORS.subtitle, fontSize: options.bold ? 10 : 9 }

    ];

}

function resolveAsesoraName(advisor) {

    return (advisor && (advisor.opportunityOwner || advisor.name)) || DEFAULT_ASESORA_NAME;

}

/*
    Un texto suelto con "width" + "alignment" NO respeta ese ancho
    cuando está posicionado con absolutePosition — pdfmake alinea
    igual contra el margen de página (que aquí casi coincide con el
    borde del cuadro verde, por eso "parecía" alineado antes). Una
    tabla de una sola celda SÍ respeta un ancho de columna explícito
    sin importar absolutePosition, así que es la forma confiable de
    lograr el padding real pedido por el cliente entre el texto y el
    borde derecho del cuadro (ver TEMPLATE_LAYOUT.greenBoxRightPadding).
*/

function buildGreenBoxValue(value, position, contentWidth) {

    return {

        absolutePosition: position,

        table: {

            widths: [contentWidth],

            body: [[

                { text: value, alignment: "right", bold: true, fontSize: 11, color: PDF_COLORS.navy, border: [false, false, false, false] }

            ]]

        },

        /*
            Padding explícito en 0 (en vez del preset "noBorders", que
            sí quita las líneas pero conserva el padding por defecto de
            pdfmake) — así "position.y" (ver TEMPLATE_LAYOUT.estudioPorText/
            asesoraText) es directamente el borde superior del texto,
            sin relleno oculto que desalinee el centrado vertical
            calculado sobre las coordenadas reales del cuadro verde.
        */

        layout: {

            hLineWidth: () => 0,

            vLineWidth: () => 0,

            paddingLeft: () => 0,

            paddingRight: () => 0,

            paddingTop: () => 0,

            paddingBottom: () => 0

        }

    };

}

function infoLine(label, value) {

    return { text: [{ text: `${label}: `, bold: true }, value || "-"], fontSize: 9, margin: [0, 1, 0, 1] };

}

/*==========================================================
 CONSTRUYE EL DOCUMENTO DE CONTENIDO (se estampa sobre la
 plantilla — nunca dibuja logo, título, acento ni los cuadros
 verdes: eso ya está en pagina-blanca-cotizacion.pdf).
==========================================================*/

async function buildOverlayDocDefinition(quote, student, advisor, optionLabel) {

    const currency = quote.currency || "AUD";

    const primaryCourse = (quote.courses && quote.courses[0]) || null;

    const usdRate = await fetchExchangeRate(currency, "USD");

    /*
        Mismo cálculo que la fila "Duración" de la tabla comparativa en
        pantalla (ver summary.js#renderComparisonTable) — SUMA la
        duración de TODOS los cursos de esta opción, no solo el primero.
        Antes usaba solo quote.courses[0].officialWeeks, lo que hacía que
        una opción con varios cursos mostrara en el PDF una duración
        distinta (menor) a la que ya veía la asesora en pantalla.
    */

    const estudioPorValue = quote.courses && quote.courses.length > 0

        ? weeksToMonthsLabel(computeTotalWeeks(quote.courses))

        : "-";

    const asesoraValue = resolveAsesoraName(advisor);

    /*
        Ancho disponible DENTRO del cuadro verde (ver TEMPLATE_LAYOUT)
        para poder alinear el valor a la derecha, igual que
        "ESTUDIO POR:"/"ASESORA:" ya vienen alineados en la propia
        plantilla — un pequeño padding de 10pt evita que el texto
        toque el borde derecho del rectángulo.
    */

    const greenBoxContentWidth = TEMPLATE_LAYOUT.greenBoxRight - TEMPLATE_LAYOUT.greenBoxLeft - TEMPLATE_LAYOUT.greenBoxRightPadding;

    return {

        pageSize: "LETTER",

        pageMargins: [TEMPLATE_LAYOUT.leftMargin, EXTRA_PAGE_LAYOUT.contentStartY, TEMPLATE_LAYOUT.rightMargin, 50],

        content: [

            buildGreenBoxValue(estudioPorValue, TEMPLATE_LAYOUT.estudioPorText, greenBoxContentWidth),

            buildGreenBoxValue(asesoraValue, TEMPLATE_LAYOUT.asesoraText, greenBoxContentWidth),

            buildProgramInfoBlock(primaryCourse, student, quote, optionLabel),

            buildCostTableSection(quote, currency, usdRate),

            buildResumenFinancieroSection(quote, currency, usdRate),

            buildObservationsSection(quote.warnings)

            /*
                Las Notas ya NO se repiten acá: viven UNA sola vez en la
                página comparativa (ver buildGeneralNotesSection, llamada
                desde buildComparativoOverlayDocDefinition) — pedido
                explícito del cliente para que no se dupliquen por cada
                opción de colegio.
            */

        ],

        footer: {

            text: COMPANY_FOOTER,

            alignment: "center",

            style: "footer",

            margin: [0, 10, 0, 0]

        },

        styles: {

            sectionTitle: { fontSize: 12, bold: true, color: PDF_COLORS.greenDark, margin: [0, 4, 0, 6] },

            tableHeader: { bold: true, fillColor: PDF_COLORS.tableHeaderFill, fontSize: 9 },

            footer: { fontSize: 8, color: PDF_COLORS.subtitle },

            warning: { fontSize: 8, color: PDF_COLORS.warning }

        },

        defaultStyle: { fontSize: 9, color: PDF_COLORS.text }

    };

}

/*==========================================================
 INFORMACIÓN GENERAL DE LA COTIZACIÓN
 ----------------------------------------------------------
 Va debajo del encabezado "Detalles del programa:" ya impreso
 en la plantilla — por eso empieza con un margin-top que salta
 esa franja (TEMPLATE_LAYOUT.contentStartY).
==========================================================*/

function buildProgramInfoBlock(primaryCourse, student, quote, optionLabel) {

    const generatedDate = quote.generatedAt

        ? new Date(quote.generatedAt).toLocaleDateString("es-CO")

        : new Date().toLocaleDateString("es-CO");

    /*
        Bloque simplificado por pedido explícito del cliente: SOLO
        fecha, colegio, nombre y correo del estudiante. Programa,
        Tipo de programa, Duración, Ciudad y Destino ya NO se
        muestran aquí (Duración sigue disponible en el cuadro verde
        "Estudio por" de la plantilla).

        "optionLabel" (ej. "Opción 1 — Colegio ABC") solo viene
        informado cuando la cotización tiene varias opciones de
        colegio (ver pricing.js#calculateOptionQuote) — identifica de
        qué opción es el detalle dentro del PDF combinado. Con una
        sola opción no se pasa, y el bloque queda exactamente igual
        que antes.
    */

    const optionLabelLine = optionLabel

        ? [{ text: optionLabel, style: "sectionTitle", margin: [0, 0, 0, 2] }]

        : [];

    const lines = primaryCourse

        ? [

            ...optionLabelLine,

            infoLine("Fecha de elaboración de la cotización", generatedDate),

            infoLine("Colegio", primaryCourse.college),

            infoLine("Nombre del estudiante", student.name),

            infoLine("Correo", student.email)

        ]

        : [...optionLabelLine, { text: "No hay cursos en esta cotización.", fontSize: 9 }];

    /*
        El margin-top real en página 1 es pageMargins.top
        (EXTRA_PAGE_LAYOUT.contentStartY) + este valor — ver la nota
        en EXTRA_PAGE_LAYOUT sobre por qué el offset se reparte así
        en vez de usar un pageMargins por página (no soportado por
        esta versión de pdfmake).
    */

    return { stack: lines, margin: [0, TEMPLATE_LAYOUT.contentStartY - EXTRA_PAGE_LAYOUT.contentStartY, 0, 14] };

}

/*==========================================================
 DESGLOSE DE COSTOS (Concepto / AUD / USD)
 ----------------------------------------------------------
 Tres tablas con título propio en verde, en este orden fijo:

   1. DESGLOSE DE COSTOS — solo lo directamente ligado al curso
      (Curso, Matrícula, Materiales), un bloque por curso.
   2. OTROS CARGOS — Seguro médico, Visa, recargo 2da aplicación,
      extras offshore (ej. Traducciones) y servicios opcionales
      (SIM Card, Recogida, etc.).
   3. COSTOS EXTRAS — SOLO exámenes médicos/biométricos, y SOLO
      si quote.extraCosts.applies (Offshore + país autorizado,
      ver pricing.js#calculateExtraCosts). Si no aplica, la
      sección completa se omite.

 El descuento NUNCA aparece acá (por pedido explícito del
 cliente), solo en el Resumen Financiero, justo antes del total.
==========================================================*/

function buildCostTableSection(quote, currency, usdRate) {

    const header = [

        { text: "Concepto", style: "tableHeader" },

        { text: "AUD", style: "tableHeader", alignment: "right" },

        { text: "USD", style: "tableHeader", alignment: "right" }

    ];

    const courseRows = [];

    (quote.courses || []).forEach((course, index) => {

        const label = quote.courses.length > 1 ? `Curso ${index + 1} — ${course.program || "-"}` : `Curso — ${course.program || "-"}`;

        courseRows.push(amountRow(label, course.price, currency, usdRate));

        courseRows.push(amountRow("Matrícula", course.enrollmentFee, currency, usdRate));

        courseRows.push(amountRow("Materiales", course.materialsFee, currency, usdRate));

    });

    const otherChargeRows = [];

    const insuranceLabel = quote.insurance.name ? `Seguro médico (${quote.insurance.name})` : "Seguro médico";

    otherChargeRows.push(amountRow(insuranceLabel, quote.insurance.cost, currency, usdRate));

    otherChargeRows.push(amountRow("Visa", quote.visa.cost, currency, usdRate));

    if (quote.secondApplicationSurcharge.applies) {

        otherChargeRows.push(amountRow("Recargo segunda aplicación", quote.secondApplicationSurcharge.totalAmount, currency, usdRate));

    }

    if (quote.offshoreExtras.applies) {

        quote.offshoreExtras.items.forEach(item => otherChargeRows.push(amountRow(item.label, item.amount, currency, usdRate)));

    }

    quote.services.forEach(service => {

        otherChargeRows.push(amountRow(`${service.label} (x${service.quantity})`, service.subtotal, currency, usdRate));

    });

    const content = [

        { text: "DESGLOSE DE COSTOS", style: "sectionTitle" },

        {

            table: { headerRows: 1, widths: ["*", 90, 90], body: [header, ...courseRows] },

            layout: "lightHorizontalLines"

        },

        { text: "OTROS CARGOS", style: "sectionTitle", margin: [0, 10, 0, 6] },

        {

            table: { headerRows: 1, widths: ["*", 90, 90], body: [header, ...otherChargeRows] },

            layout: "lightHorizontalLines"

        }

    ];

    if (quote.extraCosts && quote.extraCosts.applies) {

        const extraRows = quote.extraCosts.items.map(item => amountRow(item.label, item.amount, currency, usdRate));

        content.push(

            { text: "COSTOS EXTRAS", style: "sectionTitle", margin: [0, 10, 0, 6] },

            {

                table: { headerRows: 1, widths: ["*", 90, 90], body: [header, ...extraRows] },

                layout: "lightHorizontalLines"

            }

        );

    }

    return content;

}

/*==========================================================
 RESUMEN FINANCIERO
 ----------------------------------------------------------
 Único lugar donde aparece el descuento, justo antes del total.

 "Otros Cargos" acá es la suma de totals.otrosCargos (seguro +
 visa) + totals.adicionales (recargo 2da aplicación + extras
 offshore + servicios) — el mismo agrupamiento visual que la
 tabla "OTROS CARGOS" de buildCostTableSection. Es una fusión
 SOLO de presentación: la fórmula real de "total" sigue viviendo,
 sin cambios, en pricing.js#assembleTotals.
==========================================================*/

function buildResumenFinancieroSection(quote, currency, usdRate) {

    const totals = quote.totals;

    const otrosCargosDisplay = totals.otrosCargos + totals.adicionales;

    const rows = [

        amountRow("Subtotal Curso(s)", totals.subtotalCursos, currency, usdRate),

        amountRow("Otros Cargos", otrosCargosDisplay, currency, usdRate)

    ];

    if (totals.descuento > 0) {

        rows.push(amountRow("Descuento", totals.descuento, currency, usdRate, { negative: true }));

    }

    rows.push(amountRow("TOTAL", totals.total, currency, usdRate, { bold: true }));

    const content = [

        { text: "Resumen Financiero", style: "sectionTitle", margin: [0, 10, 0, 6] },

        {

            table: { widths: ["*", 90, 90], body: rows },

            layout: "lightHorizontalLines"

        }

    ];

    /*
        "Total de Costos Extras": informativo, visualmente
        diferenciado (fondo gris, línea delimitada arriba/abajo) y
        DELIBERADAMENTE fuera de la tabla de arriba — nunca debe
        sumarse al TOTAL (ver pricing.js#calculateExtraCosts).
    */

    if (quote.extraCosts && quote.extraCosts.applies) {

        const extraRow = amountRow("Total de Costos Extras", quote.extraCosts.total, currency, usdRate, { bold: true })

            .map(cell => ({ ...cell, fillColor: "#e8e8e8" }));

        content.push(

            {

                table: { widths: ["*", 90, 90], body: [extraRow] },

                layout: {

                    hLineWidth: () => 1,

                    vLineWidth: () => 0,

                    hLineColor: () => PDF_COLORS.border

                },

                margin: [0, 4, 0, 0]

            }

        );

    }

    return content;

}

function buildObservationsSection(warnings) {

    if (!warnings || warnings.length === 0) return [];

    return [

        { text: "Observaciones", style: "sectionTitle", margin: [0, 10, 0, 4] },

        { ul: warnings, style: "warning" }

    ];

}

/*==========================================================
 NOTAS GENERALES (texto fijo de la cotización completa)
 ----------------------------------------------------------
 Aparecen UNA sola vez en todo el documento, inmediatamente
 después del cuadro comparativo (ver buildGeneralNotesSection /
 buildComparativoOverlayDocDefinition) — YA NO se repiten en el
 desglose de cada opción de colegio (pedido explícito del
 cliente).
==========================================================*/

function collectNotes(quote) {

    const hasExtraCosts = !!(quote.extraCosts && quote.extraCosts.applies);

    const hasOffshoreTranslations = !!(

        quote.offshoreExtras &&

        quote.offshoreExtras.applies &&

        quote.offshoreExtras.items.some(item => item.code === "traducciones")

    );

    /*
        "Adicionales" (ver buildComparativoTableRows/pricing.js#assembleTotals:
        adicionales = recargo 2da aplicación + offshoreExtras.total +
        servicesSubtotal) significa cosas DISTINTAS según application_type,
        y ambos casos son mutuamente excluyentes por diseño (una
        cotización es Offshore U Onshore, nunca las dos): en Offshore
        agrupa traducciones + servicios opcionales; en Onshore con
        segunda aplicación (o posterior) es EXCLUSIVAMENTE el recargo
        fijo del Gobierno. En Onshore primera aplicación no hay nada que
        explicar (no se muestra ninguna de las dos notas).
    */

    const isOffshore = !!(quote.offshoreExtras && quote.offshoreExtras.applies);

    const secondApplicationSurcharge = quote.secondApplicationSurcharge;

    const hasSecondApplicationSurcharge = !!(secondApplicationSurcharge && secondApplicationSurcharge.applies);

    const notes = [

        "Esta cotización contiene los valores vigentes a la fecha y están sujetos a modificaciones por parte de nuestros proveedores. Para garantizar estos valores, se requiere realizar una confirmación de inscripción.",

        "Esta cotización tiene una vigencia de 15 días calendario a partir de la fecha de recepción.",

        "Los valores del seguro médico pueden estar sujetos a cambios y variar de acuerdo con el tiempo de permanencia en Australia aprobado por el Gobierno Australiano."

    ];

    if (hasExtraCosts) {

        notes.push("Los costos extras correspondientes a exámenes médicos y biométricos son valores genéricos y deben ser pagados directamente a cada entidad proveedora del servicio. Estos valores son informativos y no están incluidos en el total de la cotización.");

    }

    /*
        Nota de traducciones OFFSHORE automáticas — ver
        hasOffshoreTranslations más arriba. NO tiene relación con el
        servicio opcional "Traducción Extra".
    */

    if (hasOffshoreTranslations) {

        notes.push("El valor de las traducciones corresponde a un máximo de 21 páginas para traducir. Si los documentos exceden este número, se cobrará el valor adicional correspondiente.");

    }

    if (isOffshore) {

        notes.push("El valor correspondiente al ítem \"Adicionales\" en el cuadro comparativo incluye los costos asociados a traducciones, servicios opcionales seleccionados (como recogida en el aeropuerto, SIM Card, entre otros) y cualquier traducción adicional incluida en la cotización.");

    } else if (hasSecondApplicationSurcharge) {

        const surchargeAmountText = formatCurrency(secondApplicationSurcharge.perApplicantAmount, quote.currency);

        notes.push(`El valor correspondiente al ítem "Adicionales" corresponde al cargo adicional obligatorio de ${surchargeAmountText} exigido por el Gobierno a partir de la segunda aplicación, aplicable a cada una de las visas que se soliciten.`);

    }

    return notes;

}

function buildNotesSection(quote) {

    return [

        { text: "Notas", style: "sectionTitle", margin: [0, 10, 0, 4] },

        {

            ul: collectNotes(quote),

            fontSize: 8

        }

    ];

}

/*==========================================================
 PÁGINA COMPARATIVA (varias opciones de colegio)
 ----------------------------------------------------------
 Se estampa sobre assets/img/comparativo.pdf. Reutiliza los
 mismos helpers de derivación de datos que la tabla comparativa
 en pantalla (js/summary.js: describeOptionPrograms,
 sumOptionCourseField, insuranceRowLabel) para que ambas tablas
 siempre muestren exactamente lo mismo. A diferencia del detalle
 por opción, esta tabla muestra un solo valor por celda (la
 moneda de la cotización) — no hay columna USD, tal como lo
 pidió el cliente para el comparativo.
==========================================================*/

function buildComparativoTableRows(quote) {

    const options = quote.options || [];

    const currency = quote.currency || "AUD";

    const hasDiscount = options.some(option => option.totals.descuento > 0);

    const hasExtraCosts = !!(quote.extraCosts && quote.extraCosts.applies);

    const conceptRows = [

        ["Ciudad", option => (option.courses[0] && option.courses[0].city) || "-"],

        ["Programa", option => describeOptionPrograms(option)],

        ["Duración", option => weeksToMonthsLabel(computeTotalWeeks(option.courses))],

        ["Matrícula", option => formatCurrency(sumOptionCourseField(option.courses, "enrollmentFee"), currency)],

        ["Materiales", option => formatCurrency(sumOptionCourseField(option.courses, "materialsFee"), currency)],

        [insuranceRowLabel(options), option => formatCurrency(option.insurance.cost, currency)],

        ["Visa", option => formatCurrency(option.visa.cost, currency)],

        ["Adicionales", option => formatCurrency(option.totals.adicionales, currency)]

    ];

    if (hasDiscount) {

        conceptRows.push([

            "Descuento",

            option => option.totals.descuento > 0 ? `- ${formatCurrency(option.totals.descuento, currency)}` : "-"

        ]);

    }

    if (hasExtraCosts) {

        conceptRows.push(["Costos Extras", () => formatCurrency(quote.extraCosts.total, currency)]);

    }

    const headerRow = [

        { text: "Concepto", style: "tableHeader" },

        ...options.map(option => ({ text: option.label, style: "tableHeader", alignment: "right" }))

    ];

    const bodyRows = conceptRows.map(([label, valueFn]) => [

        { text: label, fontSize: 9, bold: true, color: PDF_COLORS.text },

        ...options.map(option => ({ text: valueFn(option), fontSize: 9, alignment: "right" }))

    ]);

    const totalRow = [

        { text: "TOTAL", fontSize: 10, bold: true, color: PDF_COLORS.greenDark },

        ...options.map(option => ({

            text: formatCurrency(option.totals.total, currency),

            fontSize: 10,

            bold: true,

            alignment: "right",

            color: PDF_COLORS.greenDark

        }))

    ];

    return { headerRow, bodyRows, totalRow, columnWidths: ["*", ...options.map(() => 90)] };

}

/*==========================================================
 NOTAS GENERALES (página comparativa)
 ----------------------------------------------------------
 Único lugar del PDF donde se muestran las Notas: aparecen UNA
 sola vez, justo después del cuadro comparativo — el desglose
 detallado de cada opción de colegio (buildOverlayDocDefinition)
 YA NO las repite. Usa las banderas a NIVEL 1 (ver
 pricing.js#calculateQuotation: quote.extraCosts/quote.offshoreExtras
 son compartidas por todas las opciones, nunca por curso ni por
 pestaña).
==========================================================*/

function buildGeneralNotesSection(quote) {

    return buildNotesSection(quote);

}

function buildComparativoOverlayDocDefinition(quote, student) {

    const generatedDate = quote.generatedAt

        ? new Date(quote.generatedAt).toLocaleDateString("es-CO")

        : new Date().toLocaleDateString("es-CO");

    const detailLines = [

        infoLine("Nombre del estudiante", student.name),

        infoLine("Correo", student.email),

        infoLine("Fecha de elaboración de la cotización", generatedDate)

    ];

    const { headerRow, bodyRows, totalRow, columnWidths } = buildComparativoTableRows(quote);

    return {

        pageSize: "LETTER",

        pageMargins: [COMPARATIVO_LAYOUT.leftMargin, EXTRA_PAGE_LAYOUT.contentStartY, COMPARATIVO_LAYOUT.rightMargin, 50],

        content: [

            /*
                No se repite un título "Detalles" acá: comparativo.pdf
                ya trae esa etiqueta impresa en la plantilla (ver
                COMPARATIVO_LAYOUT.contentStartY) — solo se estampan los
                valores. El margin-top real en página 1 es
                pageMargins.top (EXTRA_PAGE_LAYOUT.contentStartY) + este
                valor — ver la nota en EXTRA_PAGE_LAYOUT.
            */

            { stack: detailLines, margin: [0, COMPARATIVO_LAYOUT.contentStartY - EXTRA_PAGE_LAYOUT.contentStartY, 0, 16] },

            { text: "Comparativo de Opciones", style: "sectionTitle" },

            {

                table: { headerRows: 1, widths: columnWidths, body: [headerRow, ...bodyRows, totalRow] },

                layout: "lightHorizontalLines"

            },

            buildGeneralNotesSection(quote),

            {

                margin: [0, 20, 0, 0],

                table: {

                    widths: ["*"],

                    body: [[{

                        text: "En las siguientes páginas encontrará el detalle completo de cada una de las opciones de cotización presentadas en este comparativo.",

                        fontSize: 11,

                        bold: true,

                        color: PDF_COLORS.navy,

                        fillColor: "#f2f9e8",

                        margin: [10, 10, 10, 10]

                    }]]

                },

                layout: {

                    hLineWidth: () => 1,

                    vLineWidth: () => 1,

                    hLineColor: () => PDF_COLORS.green,

                    vLineColor: () => PDF_COLORS.green

                }

            }

        ],

        footer: {

            text: COMPANY_FOOTER,

            alignment: "center",

            style: "footer",

            margin: [0, 10, 0, 0]

        },

        styles: {

            sectionTitle: { fontSize: 12, bold: true, color: PDF_COLORS.greenDark, margin: [0, 4, 0, 6] },

            tableHeader: { bold: true, fillColor: PDF_COLORS.tableHeaderFill, fontSize: 9 },

            footer: { fontSize: 8, color: PDF_COLORS.subtitle }

        },

        defaultStyle: { fontSize: 9, color: PDF_COLORS.text }

    };

}

/*==========================================================
 GENERACIÓN Y ACCIONES SOBRE EL PDF
 ----------------------------------------------------------
 generateQuotationPdfBlob mantiene la misma firma pública que
 antes (quote, student, advisor -> Promise<Blob>) para que
 app.js no necesite cambiar nada. Por dentro, ahora arma:

   1. Un overlay pdfmake POR CADA OPCIÓN de colegio (reutilizando
      buildOverlayDocDefinition sin cambios, vía el adaptador
      buildLegacyOptionQuote de pricing.js — ver ese archivo).
   2. Un overlay pdfmake para la página comparativa.
   3. La portada, la plantilla de página principal, la
      plantilla del comparativo y la plantilla de página extra.

 y las fusiona con pdf-lib en el orden: portada -> comparativo
 -> detalle Opción 1 (+ overflow) -> detalle Opción 2 (+
 overflow) -> ... (ver mergeFinalPdf).

 PORTADA: las plantillas están nombradas por CIUDAD
 (assets/img/Portada-{slug-de-ciudad}.pdf: sydney, melbourne,
 brisbane), no por país/destino ("Australia", "España" — ese es
 student.destination, un valor distinto). Se usa la ciudad del
 PRIMER curso de la PRIMERA opción (mismo criterio de "programa
 principal" que ya existía antes de soportar varias pestañas) —
 en la práctica todas las opciones comparadas suelen ser
 colegios de la misma ciudad, que es justamente el punto de la
 comparación.
==========================================================*/

async function generateQuotationPdfBlob(quote, student, advisor) {

    const options = quote.options || [];

    const optionOverlayBuffers = await Promise.all(options.map(async option => {

        const legacyQuote = buildLegacyOptionQuote(quote, option);

        const overlayDocDefinition = await buildOverlayDocDefinition(legacyQuote, student, advisor, option.label);

        return renderPdfMakeBuffer(overlayDocDefinition);

    }));

    const comparativoOverlayBytes = await renderPdfMakeBuffer(buildComparativoOverlayDocDefinition(quote, student));

    const primaryCity = options[0] && options[0].courses[0] ? options[0].courses[0].city : null;

    const [coverBytes, templateBytes, comparativoTemplateBytes, extraTemplateBytes] = await Promise.all([

        primaryCity ? fetchCoverPdfBytes(primaryCity) : Promise.resolve(null),

        fetchPage2TemplateBytes(),

        fetchComparativoTemplateBytes(),

        fetchExtraPageTemplateBytes()

    ]);

    const mergedBytes = await mergeFinalPdf({

        coverBytes,

        comparativoTemplateBytes,

        comparativoOverlayBytes,

        templateBytes,

        extraTemplateBytes,

        optionOverlayBuffers

    });

    return new Blob([mergedBytes], { type: "application/pdf" });

}

function renderPdfMakeBuffer(docDefinition) {

    return new Promise((resolve, reject) => {

        try {

            pdfMake.createPdf(docDefinition).getBuffer(resolve);

        } catch (error) {

            reject(error);

        }

    });

}

/*
    Si la portada de la ciudad/destino no existe o no se pudo
    descargar, el PDF se genera igual, solo que sin página de
    portada — el comparativo y el detalle de cada opción (esos sí
    obligatorios) nunca se saltan.
*/

async function mergeFinalPdf({ coverBytes, comparativoTemplateBytes, comparativoOverlayBytes, templateBytes, extraTemplateBytes, optionOverlayBuffers }) {

    const { PDFDocument } = PDFLib;

    const finalDoc = await PDFDocument.create();

    if (coverBytes) {

        try {

            const coverDoc = await PDFDocument.load(coverBytes);

            const copiedCoverPages = await finalDoc.copyPages(coverDoc, coverDoc.getPageIndices());

            copiedCoverPages.forEach(page => finalDoc.addPage(page));

        } catch (error) {

            // Portada no válida: seguimos sin ella.

        }

    }

    const extraTemplateDoc = extraTemplateBytes ? await PDFDocument.load(extraTemplateBytes) : null;

    const comparativoTemplateDoc = await PDFDocument.load(comparativoTemplateBytes);

    const comparativoOverlayDoc = await PDFDocument.load(comparativoOverlayBytes);

    await stampOverlayOntoTemplate(finalDoc, comparativoOverlayDoc, comparativoTemplateDoc, extraTemplateDoc);

    const templateDoc = await PDFDocument.load(templateBytes);

    for (const overlayBytes of optionOverlayBuffers) {

        const overlayDoc = await PDFDocument.load(overlayBytes);

        await stampOverlayOntoTemplate(finalDoc, overlayDoc, templateDoc, extraTemplateDoc);

    }

    return finalDoc.save();

}

/*
    Estampa TODAS las páginas de "overlayDoc" sobre copias nuevas de
    una plantilla: la primera página sobre "firstTemplateDoc" —
    comparativo.pdf o pagina-blanca-cotizacion.pdf, según el
    llamador — y cualquier página adicional (el contenido no cupo en
    una sola página; pdfmake ya lo paginó automáticamente, repitiendo
    encabezados de tabla gracias a headerRows:1 en cada tabla de este
    archivo) sobre copias NUEVAS de "extraTemplateDoc"
    (pagina-extra.pdf) — nunca quedan en blanco. Si esa plantilla no
    se pudo cargar, se anexan tal cual antes que truncar la
    cotización. Factoriza la técnica embedPage+drawPage que antes
    vivía duplicada en mergeFinalPdf.
*/

async function stampOverlayOntoTemplate(finalDoc, overlayDoc, firstTemplateDoc, extraTemplateDoc) {

    const [templatePage] = await finalDoc.copyPages(firstTemplateDoc, [0]);

    finalDoc.addPage(templatePage);

    const overlayPages = overlayDoc.getPages();

    const embeddedFirstPage = await finalDoc.embedPage(overlayPages[0]);

    templatePage.drawPage(embeddedFirstPage, {

        x: 0,

        y: 0,

        width: templatePage.getWidth(),

        height: templatePage.getHeight()

    });

    if (overlayPages.length <= 1) return;

    const overflowIndices = overlayDoc.getPageIndices().slice(1);

    for (const overlayPageIndex of overflowIndices) {

        if (extraTemplateDoc) {

            const [extraPage] = await finalDoc.copyPages(extraTemplateDoc, [0]);

            finalDoc.addPage(extraPage);

            const embeddedOverflowPage = await finalDoc.embedPage(overlayPages[overlayPageIndex]);

            extraPage.drawPage(embeddedOverflowPage, {

                x: 0,

                y: 0,

                width: extraPage.getWidth(),

                height: extraPage.getHeight()

            });

        } else {

            const [overflowPage] = await finalDoc.copyPages(overlayDoc, [overlayPageIndex]);

            finalDoc.addPage(overflowPage);

        }

    }

}

function buildPdfFilename(student) {

    const safeName = (student.name || "estudiante").trim().replace(/\s+/g, "_");

    const dateStamp = new Date().toISOString().slice(0, 10);

    return `Cotizacion_${safeName}_${dateStamp}.pdf`;

}

function downloadQuotationPdf(blob, filename) {

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;

    link.download = filename;

    link.click();

    URL.revokeObjectURL(url);

}

function previewQuotationPdf(blob) {

    const url = URL.createObjectURL(blob);

    window.open(url, "_blank");

}
