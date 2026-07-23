document.addEventListener("DOMContentLoaded",()=>{

    const app=document.getElementById("app");

    app.innerHTML=

        createHeader()

        +

        createStudentCard()

        +

        createCoursesCard()

        +

        createServicesCard()

        +

        createSummaryCard();

    document

        .getElementById("btnCalculate")

        .addEventListener("click", handleCalculateQuotation);

    document

        .getElementById("btnGenerateQuotation")

        .addEventListener("click", handleGenerateQuotation);

    document

        .getElementById("btnDownloadPdf")

        .addEventListener("click", handleDownloadPdf);

    document

        .getElementById("btnPreviewPdf")

        .addEventListener("click", handlePreviewPdf);

    document

        .getElementById("btnSendEmail")

        .addEventListener("click", handleSendEmail);

    document

        .getElementById("btnConfirmSendEmail")

        .addEventListener("click", handleConfirmSendEmail);

    wireCollapsibleReopenGuard();

});



/*==========================================================
 ESTADO DE LA ÚLTIMA COTIZACIÓN GENERADA
 ----------------------------------------------------------
 app.js no calcula nada (eso es pricing.js) ni sabe hablar con
 GHL (eso es ghl.js) ni sabe construir PDFs (eso es pdf.js).
 Solo orquesta: guarda el resultado de cada paso para que el
 siguiente botón pueda usarlo.
==========================================================*/

const COLLAPSIBLE_INTAKE_CARD_IDS = ["studentCard", "coursesCard", "servicesCard"];

/*
    Red de seguridad: si algo dentro de "promise" se queda esperando
    para siempre (ej. un fetch de red que nunca responde), esto evita
    que el botón "Generar Cotización" quede en "Generando PDF..." de
    forma indefinida — pasado "ms" se rechaza con un mensaje claro en
    vez de dejar la UI congelada sin ningún error visible.
*/

function withTimeout(promise, ms, timeoutMessage) {

    let timeoutId;

    const timeout = new Promise((_, reject) => {

        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);

    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));

}

let lastCalculatedQuote = null;

let lastGeneratedPdfBlob = null;

let lastUploadedPdfUrl = null;

let lastContactId = null;



/*==========================================================
 BOTÓN "CALCULAR COTIZACIÓN"
 ----------------------------------------------------------
 Si el cálculo detecta errores de validación en CUALQUIER opción
 de colegio (quote.options[].warnings), "Generar Cotización"
 permanece deshabilitado — no se puede avanzar con una
 cotización incompleta.
==========================================================*/

async function handleCalculateQuotation() {

    const button = document.getElementById("btnCalculate");

    button.disabled = true;

    disableGenerateButton();

    disablePostGenerationActions();

    renderSummaryLoading();

    try {

        const quote = await calculateQuotation();

        lastCalculatedQuote = quote;

        renderSummary(quote);

        collapseIntakeSections();

        if (quote.options.every(option => option.warnings.length === 0)) {

            enableGenerateButton();

        }

    } catch (error) {

        renderSummaryError(`No se pudo calcular la cotización. Intenta de nuevo. (${error.message})`);

    } finally {

        button.disabled = false;

    }

}

function collapseIntakeSections() {

    COLLAPSIBLE_INTAKE_CARD_IDS.forEach(id => setCardCollapsed(id, true));

}



/*==========================================================
 BOTÓN "GENERAR COTIZACIÓN"
 ----------------------------------------------------------
 Genera el PDF y lo persiste en GHL (contacto, Quotation,
 Course Lines, Nota). NO envía ningún correo — eso es una
 acción manual y separada (ver handleSendEmail).

 El PDF ya generado (paso local, sin red) queda disponible
 para Descargar/Previsualizar aunque falle todo lo que sigue
 (persistencia en GHL) — el asesor nunca se queda sin nada.
==========================================================*/

async function handleGenerateQuotation() {

    const button = document.getElementById("btnGenerateQuotation");

    button.disabled = true;

    showSendStatus("Generando PDF...");

    const student = getStudentData();

    const advisor = getAdvisorInfo();

    try {

        lastGeneratedPdfBlob = await withTimeout(

            generateQuotationPdfBlob(lastCalculatedQuote, student, advisor),

            30000,

            "La generación del PDF tardó demasiado y fue cancelada. Intenta de nuevo."

        );

    } catch (error) {

        console.error("Error generando el PDF de la cotización:", error);

        showSendStatus(`No se pudo generar el PDF: ${error.message}`);

        button.disabled = false;

        return;

    }

    document.getElementById("btnDownloadPdf").disabled = false;

    document.getElementById("btnPreviewPdf").disabled = false;

    try {

        showSendStatus("Subiendo PDF y guardando en GoHighLevel...");

        const filename = buildPdfFilename(student);

        lastUploadedPdfUrl = await uploadQuotationPdf(lastGeneratedPdfBlob, filename);

        const { contactId } = await upsertContact({ ...student, country: countryNameToIso2(student.country) });

        lastContactId = contactId;

        const totalOptions = lastCalculatedQuote.options.length;

        const savedCount = await saveEachOptionToGhl(lastCalculatedQuote, student, advisor, contactId, lastUploadedPdfUrl, filename);

        document.getElementById("btnSendEmail").disabled = false;

        showSendStatus(

            savedCount === totalOptions

                ? `Cotización generada y guardada en GoHighLevel correctamente (${totalOptions} ${totalOptions === 1 ? "opción" : "opciones"}).`

                : `Se guardaron ${savedCount} de ${totalOptions} opciones en GoHighLevel. Puedes descargar/previsualizar el PDF igualmente.`

        );

    } catch (error) {

        console.error("Error guardando la cotización en GoHighLevel:", error);

        showSendStatus(

            `El PDF se generó, pero hubo un error al guardar en GoHighLevel: ${error.message}. ` +

            `Puedes descargar/previsualizar el PDF igualmente.`

        );

    } finally {

        button.disabled = false;

    }

}



/*==========================================================
 GUARDA EN GHL UN REGISTRO DE COTIZACIÓN POR OPCIÓN DE COLEGIO
 ----------------------------------------------------------
 Todas las opciones comparten el mismo contacto y el mismo PDF
 (portada + comparativo + detalle de todas las opciones es un
 solo archivo, ver pdf.js), pero cada una queda como su propio
 registro "Quotation" + "Course Lines" en GHL — reutiliza sin
 cambios buildQuotationHeader/buildQuotationLines/
 buildQuotationNoteText (ver más abajo), una vez por opción, con
 el "quote" plano que arma pricing.js#buildLegacyOptionQuote.
 quotation_code se sufija por letra (COT-XXXXXXXXXXXX-A, -B...)
 para que nunca choquen entre sí aunque se generen en el mismo
 segundo. Si una opción falla al guardar, se sigue con las demás
 — el asesor nunca se queda sin nada.
==========================================================*/

const OPTION_CODE_SUFFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function saveEachOptionToGhl(quote, student, advisor, contactId, pdfUrl, filename) {

    let savedCount = 0;

    for (let index = 0; index < quote.options.length; index++) {

        const option = quote.options[index];

        const legacyQuote = buildLegacyOptionQuote(quote, option);

        try {

            const header = buildQuotationHeader(legacyQuote, student, advisor, pdfUrl);

            header.quotation_code = `${header.quotation_code}-${OPTION_CODE_SUFFIXES[index] || (index + 1)}`;

            const { quotationRecordId } = await upsertQuotationRecord(header, contactId);

            await upsertLineItems(quotationRecordId, buildQuotationLines(legacyQuote));

            await createQuotationNote(contactId, `${option.label}\n${buildQuotationNoteText(legacyQuote, student, pdfUrl, filename)}`);

            savedCount++;

        } catch (error) {

            // Se continúa con las demás opciones — ver comentario de la función.

        }

    }

    return savedCount;

}



/*==========================================================
 DESCARGAR / PREVISUALIZAR (locales, no requieren GHL)
==========================================================*/

function handleDownloadPdf() {

    if (!lastGeneratedPdfBlob) return;

    downloadQuotationPdf(lastGeneratedPdfBlob, buildPdfFilename(getStudentData()));

}

function handlePreviewPdf() {

    if (!lastGeneratedPdfBlob) return;

    previewQuotationPdf(lastGeneratedPdfBlob);

}



/*==========================================================
 BOTÓN "ENVIAR POR CORREO"
 ----------------------------------------------------------
 Acción manual y separada — el asesor decide cuándo enviarlo,
 nunca ocurre automáticamente al generar la cotización.
==========================================================*/

/*
    "Enviar por Correo" ya NO envía directamente: abre el panel de
    redacción (ver summary.js#showEmailComposePanel) con un asunto/mensaje
    de ejemplo ya armado, para que la asesora lo revise y edite antes de
    confirmar. El envío real ocurre en handleConfirmSendEmail().
*/

function handleSendEmail() {

    const student = getStudentData();

    showEmailComposePanel(

        "Tu cotización académica — LatinAdvisor",

        buildQuotationEmailText(lastCalculatedQuote, student)

    );

}

async function handleConfirmSendEmail() {

    const button = document.getElementById("btnConfirmSendEmail");

    button.disabled = true;

    showSendStatus("Enviando correo...");

    try {

        const subject = document.getElementById("emailSubject").value;

        const body = document.getElementById("emailBody").value;

        await sendQuotationEmail({

            contactId: lastContactId,

            subject,

            html: textToHtml(body),

            attachmentUrl: lastUploadedPdfUrl

        });

        showSendStatus("Correo enviado correctamente.");

        hideEmailComposePanel();

    } catch (error) {

        showSendStatus(`No se pudo enviar el correo: ${error.message}`);

    } finally {

        button.disabled = false;

    }

}

function buildQuotationEmailText(quote, student) {

    const optionsText = quote.options

        .map(option => `- ${option.label}: ${quote.currency} $${Number(option.totals.total).toLocaleString("en-AU")}`)

        .join("\n");

    return [

        `Hola ${student.name || ""},`,

        "",

        "Adjunto encontrarás tu cotización académica preparada por LatinAdvisor, con el comparativo de las opciones cotizadas:",

        "",

        optionsText,

        "",

        "Cualquier duda, quedamos atentos.",

        "",

        "Saludos,",

        "LatinAdvisor"

    ].join("\n");

}

/*
    Convierte el texto plano editado por la asesora en el HTML simple que
    espera GHL para el cuerpo del correo — escapa caracteres especiales
    (para que algo como "<" escrito a mano no rompa el HTML) y respeta los
    saltos de línea que la asesora haya dejado.
*/

function textToHtml(text) {

    const escaped = String(text || "")

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;");

    return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;

}



/*==========================================================
 MAPEO quote -> ESQUEMA DE GHL (Custom Objects)
 ----------------------------------------------------------
 Traduce el objeto "quote" de pricing.js al esquema de campos
 de los Custom Objects "Quotation"/"Course Line" definidos en
 GHL. Vive aquí (no en ghl.js ni en pricing.js) porque es
 exactamente el punto de contacto entre ambos mundos.
==========================================================*/

function buildQuotationCode() {

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

    return `COT-${stamp}`;

}

function buildQuotationHeader(quote, student, advisor, pdfUrl) {

    return {

        quotation_code: buildQuotationCode(),

        destination: student.destination,

        country: student.country || "",

        application_type: student.application_type,

        application_number: student.application_number,

        quotation_type: student.quotation_type,

        number_applicants: student.number_applicants,

        insurance_name: quote.insurance.name || "",

        currency: quote.currency,

        subtotal_cursos: quote.totals.subtotalCursos,

        otros_cargos: quote.totals.otrosCargos,

        adicionales: quote.totals.adicionales,

        descuento: quote.totals.descuento,

        total: quote.totals.total,

        total_costos_extras: (quote.extraCosts && quote.extraCosts.total) || 0,

        internal_status: "generada",

        pdf_url: pdfUrl,

        // Misma prioridad que pdf.js#resolveAsesoraName: el Owner real del
        // contacto (ver student.js#applyContactOwnerToAdvisor) manda sobre
        // el parámetro de URL, que hoy casi siempre llega vacío.
        advisor_name: advisor.opportunityOwner || advisor.name,

        advisor_email: advisor.opportunityOwnerEmail || advisor.email

    };

}

function buildQuotationLines(quote) {

    const courseLines = quote.courses.map((course, index) => ({

        line_type: "course",

        college: course.college,

        city: course.city,

        course_type: course.type,

        course_subtype: course.subtype,

        program: course.program,

        weeks: course.officialWeeks || course.requestedWeeks || 0,

        price: course.price,

        enrollment_fee: course.enrollmentFee,

        materials_fee: course.materialsFee,

        discount: course.discount,

        discount_source: course.discountSource || "",

        subtotal: course.subtotal,

        sort_order: index

    }));

    const serviceLines = quote.services.map((service, index) => ({

        line_type: "service",

        program: service.label,

        weeks: 0,

        price: service.unitCost,

        enrollment_fee: 0,

        materials_fee: 0,

        discount: 0,

        discount_source: "",

        subtotal: service.subtotal,

        sort_order: courseLines.length + index

    }));

    return [...courseLines, ...serviceLines];

}

function buildQuotationNoteText(quote, student, pdfUrl, filename) {

    const courseNames = quote.courses.map(course => course.program || course.type || "Curso").join(", ");

    const lines = [

        `Cotización generada: ${new Date().toLocaleString("es-CO")}`,

        `Destino: ${student.destination}`,

        `Tipo de aplicación: ${student.application_type}`,

        `Tipo de cotización: ${student.quotation_type}`,

        `N° aplicantes: ${student.number_applicants}`,

        `Cursos (${quote.courses.length}): ${courseNames}`,

        `Seguro médico: ${quote.insurance.name || "-"}`,

        `Total Cotización: ${quote.currency} $${Number(quote.totals.total).toLocaleString("en-AU")}`,

        ...(quote.extraCosts && quote.extraCosts.applies

            ? [`Total Costos Extras: ${quote.currency} $${Number(quote.extraCosts.total).toLocaleString("en-AU")}`]

            : []),

        `Estado: Generada`,

        `PDF: ${filename} — ${pdfUrl}`

    ];

    return lines.join("\n");

}



/*==========================================================
 SI EL ASESOR REABRE UNA SECCIÓN YA COLAPSADA PARA MODIFICARLA,
 tanto "Generar Cotización" como el trío Descargar/Previsualizar/
 Enviar se deshabilitan de nuevo: el resumen y el PDF ya
 generado pudieron quedar desactualizados hasta que recalcule.
==========================================================*/

function wireCollapsibleReopenGuard() {

    document.addEventListener("click", event => {

        const header = event.target.closest(".card-header-toggle");

        if (!header) return;

        const card = header.closest(".card");

        if (!card || !COLLAPSIBLE_INTAKE_CARD_IDS.includes(card.id)) return;

        const justExpanded = !card.classList.contains("card-collapsed");

        if (justExpanded) {

            disableGenerateButton();

            disablePostGenerationActions();

        }

    });

}
