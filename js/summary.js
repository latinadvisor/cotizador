/*==========================================================
 LATINADVISOR
 SUMMARY MODULE
 VERSION 3.0 — COMPARATIVO DE OPCIONES DE COLEGIO
 ----------------------------------------------------------
 Este módulo NO calcula nada. Solo renderiza el objeto "quote"
 que produce pricing.js#calculateQuotation() — ahora con una
 entrada por opción de colegio (quote.options[]). El botón
 "Calcular Cotización" se cablea desde app.js (orquestación),
 no desde aquí.

 El resumen en pantalla muestra una TABLA COMPARATIVA (una
 columna por opción/colegio) con los conceptos generales de
 cada alternativa — el desglose línea por línea de cada opción
 (matrícula/materiales por curso, notas, etc.) vive en el PDF
 final, no en esta pantalla. Ninguna columna se suma con otra:
 son alternativas independientes que el estudiante compara.
==========================================================*/



/*==========================================================
 CREA LA TARJETA DE RESUMEN
==========================================================*/

function createSummaryCard() {

    return createCard(

        "Resumen de Cotización",

        `

        <div id="summaryContent">

            <div class="placeholder">

                Aquí aparecerán los totales.

            </div>

        </div>

        <div class="calculate-container">

            ${createButton("Calcular Cotización", "btnCalculate")}

        </div>

        <div class="send-container">

            ${createButton("Generar Cotización", "btnGenerateQuotation", { disabled: true, variant: "secondary" })}

        </div>

        <div class="post-generation-actions">

            ${createButton("Descargar PDF", "btnDownloadPdf", { disabled: true, variant: "secondary" })}

            ${createButton("Previsualizar PDF", "btnPreviewPdf", { disabled: true, variant: "secondary" })}

            ${createButton("Enviar por Correo", "btnSendEmail", { disabled: true, variant: "secondary" })}

        </div>

        <div id="emailComposeContainer" class="email-compose hidden">

            <div class="form-group">

                <label for="emailSubject">Asunto</label>

                <input id="emailSubject" type="text">

            </div>

            <div class="form-group">

                <label for="emailBody">Mensaje</label>

                <textarea id="emailBody" rows="8"></textarea>

            </div>

            ${createButton("Confirmar y Enviar", "btnConfirmSendEmail")}

        </div>

        <div id="sendStatus" class="lead-status hidden"></div>

        `

    );

}

/*==========================================================
 PANEL DE REDACCIÓN DEL CORREO
 ----------------------------------------------------------
 "Enviar por Correo" ya no dispara el envío directamente: abre
 este panel con el asunto/mensaje por defecto ya redactados
 (ver app.js#handleSendEmail), para que la asesora pueda
 revisarlos y editarlos antes de confirmar el envío real (ver
 app.js#handleConfirmSendEmail).
==========================================================*/

function showEmailComposePanel(defaultSubject, defaultBody) {

    document.getElementById("emailSubject").value = defaultSubject;

    document.getElementById("emailBody").value = defaultBody;

    document.getElementById("emailComposeContainer").classList.remove("hidden");

}

function hideEmailComposePanel() {

    document.getElementById("emailComposeContainer").classList.add("hidden");

}



/*==========================================================
 HABILITAR / DESHABILITAR "GENERAR COTIZACIÓN"
 ----------------------------------------------------------
 Solo se habilita cuando calculateQuotation() termina sin
 errores de validación en NINGUNA opción (ver
 app.js#handleCalculateQuotation) y el resumen ya está
 renderizado. app.js la deshabilita de nuevo si el asesor
 reabre una sección para modificar algo, forzando un nuevo
 cálculo antes de poder generar.
==========================================================*/

function enableGenerateButton() {

    const button = document.getElementById("btnGenerateQuotation");

    if (button) button.disabled = false;

}

function disableGenerateButton() {

    const button = document.getElementById("btnGenerateQuotation");

    if (button) button.disabled = true;

}



/*==========================================================
 HABILITAR / DESHABILITAR ACCIONES POST-GENERACIÓN
 ----------------------------------------------------------
 Descargar/Previsualizar/Enviar por Correo solo tienen sentido
 una vez que "Generar Cotización" produjo un PDF real. El envío
 de correo SIEMPRE es una acción manual y separada — nunca se
 dispara automáticamente al generar.
==========================================================*/

function enablePostGenerationActions() {

    ["btnDownloadPdf", "btnPreviewPdf", "btnSendEmail"].forEach(id => {

        const button = document.getElementById(id);

        if (button) button.disabled = false;

    });

}

function disablePostGenerationActions() {

    ["btnDownloadPdf", "btnPreviewPdf", "btnSendEmail"].forEach(id => {

        const button = document.getElementById(id);

        if (button) button.disabled = true;

    });

    const status = document.getElementById("sendStatus");

    if (status) status.classList.add("hidden");

    hideEmailComposePanel();

}

function showSendStatus(message) {

    const status = document.getElementById("sendStatus");

    if (!status) return;

    status.textContent = message;

    status.classList.remove("hidden");

}



/*==========================================================
 ESTADO "CALCULANDO..."
==========================================================*/

function renderSummaryLoading() {

    const container = document.getElementById("summaryContent");

    if (!container) return;

    container.innerHTML = `

        <div class="placeholder">

            Calculando cotización...

        </div>

    `;

}



/*==========================================================
 ESTADO DE ERROR
==========================================================*/

function renderSummaryError(message) {

    const container = document.getElementById("summaryContent");

    if (!container) return;

    container.innerHTML = `<div class="summary-error">⚠ ${message}</div>`;

}



/*==========================================================
 RENDERIZA EL RESUMEN COMPLETO
==========================================================*/

function renderSummary(quote) {

    const container = document.getElementById("summaryContent");

    if (!container) return;

    container.innerHTML =

        renderWarnings(quote.options) +

        renderComparisonTable(quote);

}



/*==========================================================
 ADVERTENCIAS
 ----------------------------------------------------------
 Se listan las de TODAS las opciones, prefijadas con la
 etiqueta de la opción, para que la asesora sepa en qué
 pestaña está el problema.
==========================================================*/

function renderWarnings(options) {

    const allWarnings = [];

    (options || []).forEach(option => {

        (option.warnings || []).forEach(warning => {

            allWarnings.push(`${option.label}: ${warning}`);

        });

    });

    if (allWarnings.length === 0) return "";

    const items = allWarnings

        .map(warning => `<div class="summary-warning">⚠ ${warning}</div>`)

        .join("");

    return `<div class="summary-section">${items}</div>`;

}



/*==========================================================
 TABLA COMPARATIVA
 ----------------------------------------------------------
 Una columna por opción de colegio. Cada fila es un concepto
 general (Ciudad, Programa, Duración, Matrícula, Materiales,
 Seguro Médico, Visa, Adicionales, Descuento si aplica, Costos
 Extras si aplica, Total). Ninguna fila suma columnas entre sí
 — son alternativas de comparación, no partidas de un mismo
 total.
==========================================================*/

function renderComparisonTable(quote) {

    const options = quote.options || [];

    if (options.length === 0) {

        return `

            <div class="summary-section">

                <div class="section-title">Cursos</div>

                <div class="placeholder">No hay opciones de cotización.</div>

            </div>

        `;

    }

    const currency = quote.currency || "AUD";

    const hasDiscount = options.some(option => option.totals.descuento > 0);

    const hasExtraCosts = !!(quote.extraCosts && quote.extraCosts.applies);

    const headerCells = options.map(option => `<th>${option.label}</th>`).join("");

    const rows = [

        buildComparisonRow("Ciudad", options, option => (option.courses[0] && option.courses[0].city) || "-"),

        buildComparisonRow("Programa", options, option => describeOptionPrograms(option)),

        buildComparisonRow("Duración", options, option => weeksToMonthsLabel(computeTotalWeeks(option.courses))),

        buildComparisonRow("Matrícula", options, option => formatCurrency(sumOptionCourseField(option.courses, "enrollmentFee"), currency)),

        buildComparisonRow("Materiales", options, option => formatCurrency(sumOptionCourseField(option.courses, "materialsFee"), currency)),

        buildComparisonRow(insuranceRowLabel(options), options, option => formatCurrency(option.insurance.cost, currency)),

        buildComparisonRow("Visa", options, option => formatCurrency(option.visa.cost, currency)),

        buildComparisonRow("Adicionales", options, option => formatCurrency(option.totals.adicionales, currency))

    ];

    if (hasDiscount) {

        rows.push(buildComparisonRow(

            "Descuento",

            options,

            option => option.totals.descuento > 0 ? `- ${formatCurrency(option.totals.descuento, currency)}` : "-",

            "comparison-row-discount"

        ));

    }

    if (hasExtraCosts) {

        rows.push(buildComparisonRow("Costos Extras", options, () => formatCurrency(quote.extraCosts.total, currency)));

    }

    rows.push(buildComparisonRow("Total", options, option => formatCurrency(option.totals.total, currency), "comparison-row-total"));

    const extraCostsNote = hasExtraCosts

        ? `

            <div class="summary-extra-note">

                Costos Extras: valores genéricos que deben pagarse directamente a cada entidad proveedora del servicio. No están incluidos en el Total.

            </div>

        `

        : "";

    return `

        <div class="summary-section">

            <div class="section-title">Comparativo de Opciones</div>

            <div class="comparison-table-wrapper">

                <table class="comparison-table">

                    <thead><tr><th>Concepto</th>${headerCells}</tr></thead>

                    <tbody>${rows.join("")}</tbody>

                </table>

            </div>

            ${extraCostsNote}

        </div>

    `;

}

function buildComparisonRow(label, options, valueFn, extraClass = "") {

    const cells = options.map(option => `<td>${valueFn(option)}</td>`).join("");

    return `<tr class="${extraClass}"><td>${label}</td>${cells}</tr>`;

}

function describeOptionPrograms(option) {

    if (!option.courses || option.courses.length === 0) return "-";

    return option.courses.map(course => course.program || course.type || "-").join(" + ");

}

function sumOptionCourseField(courses, field) {

    return (courses || []).reduce((sum, course) => sum + (course[field] || 0), 0);

}

function insuranceRowLabel(options) {

    const named = options.find(option => option.insurance.name);

    return named ? `Seguro médico (${named.insurance.name})` : "Seguro Médico";

}



/*==========================================================
 UTILIDADES DE RENDERIZADO
==========================================================*/

function formatCurrency(amount, currency = "AUD") {

    const value = Number(amount) || 0;

    return `${currency} $${value.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

}
