/*==========================================================
 LATINADVISOR
 GHL MODULE (GoHighLevel)
 VERSION 2.0 — CONEXIÓN REAL VÍA CLOUDFLARE WORKER
 ----------------------------------------------------------
 Este módulo NUNCA habla con GoHighLevel directamente — un
 token de API no puede vivir en JavaScript de navegador.
 Habla exclusivamente con el relay (ver worker/ghl-relay.js),
 que es quien guarda el Private Integration Token.

 Mientras GHL_RELAY_BASE_URL esté vacío, todas las funciones
 devuelven datos simulados (modo desarrollo/pruebas) — el
 resto de la app funciona igual, sin romperse. En cuanto se
 despliegue el Worker y se complete esta constante, todo pasa
 a ser real sin tocar ningún otro módulo.
==========================================================*/

const GHL_RELAY_BASE_URL = "https://ghl-relay.marketing-7e9.workers.dev"; // Worker ya desplegado

const APP_SHARED_SECRET = "LatinAdvi$or*_20%06%89_c0tiz4d0r2026#"; // debe ser idéntico al APP_SHARED_SECRET configurado en el Worker

function isGhlRelayConfigured() {

    return GHL_RELAY_BASE_URL.length > 0;

}

async function ghlRelayRequest(path, method, body) {

    const response = await fetch(GHL_RELAY_BASE_URL + path, {

        method,

        headers: {

            "Content-Type": "application/json",

            "X-App-Secret": APP_SHARED_SECRET

        },

        body: body !== undefined ? JSON.stringify(body) : undefined

    });

    const data = await response.json();

    if (!response.ok) {

        throw new Error(data.error || `Error de comunicación con GHL (HTTP ${response.status})`);

    }

    return data;

}

function blobToBase64(blob) {

    return new Promise((resolve, reject) => {

        const reader = new FileReader();

        reader.onloadend = () => resolve(String(reader.result).split(",")[1]);

        reader.onerror = reject;

        reader.readAsDataURL(blob);

    });

}

/*==========================================================
 CONTACTOS
==========================================================*/

async function searchLeadByEmailOrPhone(query) {

    if (!isGhlRelayConfigured()) {

        console.info("[ghl.js] Relay no configurado — búsqueda simulada (sin resultado).");

        return null;

    }

    const { contact } = await ghlRelayRequest("/contacts/search", "POST", { query });

    return contact;

}

async function upsertContact(studentData) {

    if (!isGhlRelayConfigured()) {

        return { contactId: "mock-contact-1" };

    }

    return ghlRelayRequest("/contacts/upsert", "POST", { studentData });

}

/*==========================================================
 COTIZACIÓN (Custom Object "Quotation" + "Course Line")
==========================================================*/

async function upsertQuotationRecord(header, contactId, quotationRecordId) {

    if (!isGhlRelayConfigured()) {

        return { quotationRecordId: quotationRecordId || "mock-quotation-1" };

    }

    return ghlRelayRequest("/quotations/upsert", "POST", { header, contactId, quotationRecordId });

}

async function upsertLineItems(quotationRecordId, lines) {

    if (!isGhlRelayConfigured()) {

        return { count: lines.length };

    }

    return ghlRelayRequest(`/quotations/${quotationRecordId}/lines`, "POST", { lines });

}

/*==========================================================
 HISTORIAL DE COTIZACIONES DE UN CONTACTO
==========================================================*/

async function getPreviousQuotations(contactId) {

    if (!isGhlRelayConfigured()) {

        return [];

    }

    const { quotations } = await ghlRelayRequest(`/quotations/by-contact/${contactId}`, "GET");

    return quotations || [];

}

/*==========================================================
 ARCHIVO PDF (GHL Media Library)
==========================================================*/

async function uploadQuotationPdf(pdfBlob, filename) {

    if (!isGhlRelayConfigured()) {

        return `mock://pdf/${filename}`;

    }

    const fileBase64 = await blobToBase64(pdfBlob);

    const { url } = await ghlRelayRequest("/media/upload", "POST", { fileBase64, filename, mimeType: "application/pdf" });

    return url;

}

/*==========================================================
 NOTA DEL CONTACTO (historial legible por humanos)
==========================================================*/

async function createQuotationNote(contactId, noteText) {

    if (!isGhlRelayConfigured()) {

        return { noteId: "mock-note-1" };

    }

    return ghlRelayRequest("/notes", "POST", { contactId, body: noteText });

}

/*==========================================================
 OPORTUNIDAD (Pipeline "Advising Process" — Stage "Quote created")
==========================================================*/

async function upsertOpportunity({ contactId, name, monetaryValue }) {

    if (!isGhlRelayConfigured()) {

        return { opportunityId: "mock-opportunity-1", created: true };

    }

    return ghlRelayRequest("/opportunities/upsert", "POST", { contactId, name, monetaryValue });

}

/*==========================================================
 ENVÍO DE CORREO (acción manual del asesor, ver app.js)
==========================================================*/

async function sendQuotationEmail({ contactId, subject, html, attachmentUrl, attachmentFilename }) {

    if (!isGhlRelayConfigured()) {

        return { messageId: "mock-message-1" };

    }

    return ghlRelayRequest("/email/send", "POST", { contactId, subject, html, attachmentUrl, attachmentFilename });

}
