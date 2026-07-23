/*==========================================================
 LATINADVISADOR STUDENT MODULE
 VERSION 2.0
==========================================================*/



/*==========================================================
 IDENTIDAD DEL ASESOR
 ----------------------------------------------------------
 Cuando el cotizador se abre desde un Custom Menu Link dentro
 de GHL, la URL puede traer advisor_name/advisor_email ya
 resueltos por GHL (ej. {{user.first_name}} {{user.last_name}}
 y {{user.email}} en la configuración del menú). Si no vienen
 (pruebas locales, fuera de GHL), quedan vacíos sin romper nada.
==========================================================*/

/*
    "opportunityOwner" queda listo para cuando GHL empiece a
    resolver el Owner de la oportunidad en el Custom Menu Link
    (ej. {{opportunity.owner.name}}) y lo pase como
    "opportunity_owner" en la URL — el PDF (ver pdf.js) ya lo
    usa como fuente preferida sobre el nombre ficticio, así que
    ese día no habrá que tocar la estructura del documento.
*/

function getAdvisorInfo() {

    const params = new URLSearchParams(window.location.search);

    return {

        name: params.get("advisor_name") || "",

        email: params.get("advisor_email") || "",

        opportunityOwner: params.get("opportunity_owner") || ""

    };

}

/*==========================================================
 PAÍS DEL ESTUDIANTE
 ----------------------------------------------------------
 La FUENTE FINAL DE VERDAD para el país es siempre el select
 #student_country (ver getStudentData()) — alimenta
 directamente pricing.js#isCountryEligibleForMedicalExams, sin
 importar si el valor llegó automático desde GHL (búsqueda de
 lead, ver applyLeadToForm) o fue elegido a mano por la asesora.
 El campo NUNCA queda bloqueado: siempre es editable.

 getStudentCountryFromGhl() solo se usa como ATAJO INICIAL: si
 el cotizador se abre desde un Custom Menu Link de GHL con
 "country" en la URL (igual mecanismo que advisor_name/
 advisor_email en getAdvisorInfo()), se preselecciona ese país
 en el select al cargar la tarjeta — ver prefillCountryFromGhl().
==========================================================*/

function getStudentCountryFromGhl() {

    const params = new URLSearchParams(window.location.search);

    return params.get("country") || "";

}

const NATIONALITY_OPTIONS = [

    "Argentina", "Colombiana", "Mexicana", "Chilena", "Ecuatoriana",
    "Venezolana", "Española", "Peruana", "Uruguaya", "Otra"

];

function buildCountryNameOptions() {

    return WORLD_COUNTRIES

        .map(country => country.name)

        .sort((a, b) => a.localeCompare(b, "es"));

}

/*
    El campo estándar "country" de GHL guarda un código ISO2 (ej. "DZ"
    para Algeria) — se compara primero por código, exacto y sin
    ambigüedad de idioma. Como respaldo (por si algún día llega texto
    libre en vez de un código), se intenta también contra el nombre en
    español y, si tampoco calza, contra ENGLISH_COUNTRY_ALIASES —
    comparación tolerante a mayúsculas/acentos (mismo criterio que
    normalize()/stripAccents() de database.js, ya cargado antes que
    este módulo — ver index.html).
*/

function findCountryByName(rawName) {

    if (!rawName) return null;

    const raw = String(rawName).trim();

    if (raw.length === 2) {

        const byIso2 = WORLD_COUNTRIES.find(country => country.iso2 === raw.toUpperCase());

        if (byIso2) return byIso2;

    }

    const target = stripAccents(normalize(raw));

    const bySpanishName = WORLD_COUNTRIES.find(country => stripAccents(normalize(country.name)) === target);

    if (bySpanishName) return bySpanishName;

    // GHL guarda el país en inglés — ver ENGLISH_COUNTRY_ALIASES en countries.js.
    return WORLD_COUNTRIES.find(country => (ENGLISH_COUNTRY_ALIASES[country.iso2] || []).includes(target)) || null;

}

/*
    Mismo criterio de comparación tolerante que findCountryByName, pero
    contra la lista fija de gentilicios del select #student_nationality
    (ver NATIONALITY_OPTIONS más abajo) — GHL guarda el gentilicio en
    minúsculas (ej. "colombiana"), esto lo hace calzar sin importar
    mayúsculas/acentos.
*/

function findNationalityByName(rawNationality) {

    if (!rawNationality) return null;

    const target = stripAccents(normalize(rawNationality));

    return NATIONALITY_OPTIONS.find(option => stripAccents(normalize(option)) === target) || null;

}

function prefillCountryFromGhl() {

    const matched = findCountryByName(getStudentCountryFromGhl());

    if (!matched) return;

    const select = document.getElementById("student_country");

    if (select) select.value = matched.name;

}

/*==========================================================
 TELÉFONO INTERNACIONAL (INDICATIVO + NÚMERO)
 ----------------------------------------------------------
 Dos controles independientes en vez de un único input: el
 indicativo (#student_phone_code, ej. "+57") y el número
 (#student_phone_number). Independiente del país del estudiante
 por diseño — un estudiante colombiano puede tener un teléfono
 con indicativo de Australia — ver parsePhoneNumber() y
 applyContactPhoneToForm() más abajo.
==========================================================*/

function buildPhoneCodeOptionsHtml() {

    const byIso2 = new Map(WORLD_COUNTRIES.map(country => [country.iso2, country]));

    const priorityCountries = PRIORITY_COUNTRY_CODES.map(iso2 => byIso2.get(iso2)).filter(Boolean);

    const restCountries = WORLD_COUNTRIES

        .filter(country => !PRIORITY_COUNTRY_CODES.includes(country.iso2))

        .slice()

        .sort((a, b) => a.name.localeCompare(b.name, "es"));

    const optionHtml = country => `<option value="${country.dialCode}">${country.dialCode} ${country.name}</option>`;

    return (

        `<option value="">Indicativo</option>` +

        priorityCountries.map(optionHtml).join("") +

        `<option value="" disabled>──────────</option>` +

        restCountries.map(optionHtml).join("")

    );

}

function createPhoneFieldHtml() {

    return `

    <div class="form-group">

        <label for="student_phone_number">Teléfono</label>

        <div class="phone-field-row">

            <select id="student_phone_code" aria-label="Indicativo telefónico">

                ${buildPhoneCodeOptionsHtml()}

            </select>

            <input
                id="student_phone_number"
                type="tel"
                placeholder="Número de teléfono">

        </div>

    </div>

    `;

}

/*
    Intenta separar un teléfono de GHL (ej. "+57 3001234567") en
    indicativo + número, probando los indicativos conocidos de
    MÁS largos a MÁS cortos (para no confundir, ej., "+1868"
    Trinidad y Tobago con el "+1" genérico de Norteamérica). Si
    el teléfono no trae "+" o no coincide con ningún indicativo
    conocido, retorna dialCode vacío — la asesora corrige a mano.
*/

function parsePhoneNumber(rawPhone) {

    const cleaned = String(rawPhone || "").replace(/[\s().-]/g, "");

    if (!cleaned.startsWith("+")) {

        return { dialCode: "", number: String(rawPhone || "").trim() };

    }

    const knownDialCodes = [...new Set(WORLD_COUNTRIES.map(country => country.dialCode))]

        .sort((a, b) => b.length - a.length);

    const matchedCode = knownDialCodes.find(code => cleaned.startsWith(code));

    if (!matchedCode) {

        return { dialCode: "", number: String(rawPhone || "").trim() };

    }

    return { dialCode: matchedCode, number: cleaned.slice(matchedCode.length) };

}

function createStudentCard() {

    let html = "";

    /*==================================================
      BUSCADOR GHL
    ==================================================*/

    html += `
        <div class="lead-search">

            <div class="lead-search-title">
                Buscar Lead en GoHighLevel
            </div>

            <div class="lead-search-grid">

                <div class="form-group">

                    <label for="search_email">
                        Correo electrónico
                    </label>

                    <input
                        id="search_email"
                        type="email"
                        placeholder="ejemplo@email.com">

                </div>

                <div class="lead-search-button">

                    ${createButton("Buscar Lead","btnSearchLead")}

                </div>

            </div>

            <div
                id="leadStatus"
                class="lead-status">

                Aún no se ha realizado ninguna búsqueda.

            </div>

            <div
                id="leadHistory"
                class="lead-status hidden">
            </div>

        </div>
    `;



    /*==================================================
      INFORMACIÓN PERSONAL
    ==================================================*/

    html += createSectionTitle("Información Personal");

    html += createInput({

        label:"Nombre completo",

        id:"student_name",

        placeholder:"Nombre completo"

    });

    html += createInput({

        label:"Correo",

        id:"student_email",

        type:"email",

        placeholder:"correo@email.com"

    });

    html += createPhoneFieldHtml();

    html += createSelect({

        label:"País",

        id:"student_country",

        options:["Seleccionar", ...buildCountryNameOptions()]

    });

    html += createSelect({

        label:"Nacionalidad",

        id:"student_nationality",

        options:["Seleccionar", ...NATIONALITY_OPTIONS]

    });



    /*==================================================
      INFORMACIÓN DEL PROCESO
    ==================================================*/

    html += createSectionTitle("Información del Proceso");



    html += createSelect({

        label:"Destino",

        id:"destination",

        options:[

            "Australia",

            "España",

            "Dubái"

        ]

    });



    html += createSelect({

        label:"Tipo de Aplicación",

        id:"application_type",

        options:[

            "Onshore",

            "Offshore"

        ]

    });



    html += createInput({

        label:"Número de Aplicación",

        id:"application_number",

        type:"number",

        min:"1",

        step:"1",

        placeholder:"1"

    });



    html += createSelect({

        label:"Tipo de Cotización",

        id:"quotation_type",

        options:[

            "Single",

            "Couple",

            "Family"

        ]

    });



    html += createInput({

        label:"Cantidad de Aplicantes",

        id:"number_applicants",

        type:"number",

        min:"1",

        step:"1",

        placeholder:"1"

    });



    html += createSelect({

        label:"Seguro Médico",

        id:"insurance",

        options:["Cargando..."]

    });



    /*
        El botón "Buscar Lead" aún no existe en el DOM en este
        punto: app.js concatena todas las tarjetas antes de
        asignarlas a app.innerHTML. Se difiere el cableado de
        eventos al siguiente ciclo del event loop, igual que en
        courses.js.
    */

    setTimeout(() => {

        wireStudentCardEvents();

        loadInsuranceOptions();

        prefillCountryFromGhl();

    }, 0);

    return createCard(

        "Datos del Estudiante",

        `

        <div class="form-grid">

            ${html}

        </div>

        `,

        { id: "studentCard", collapsible: true }

    );

}



/*==========================================================
 BÚSQUEDA DE LEAD EN GOHIGHLEVEL
==========================================================*/

function wireStudentCardEvents() {

    const button = document.getElementById("btnSearchLead");

    if (button) button.addEventListener("click", handleSearchLead);

    const destinationSelect = document.getElementById("destination");

    if (destinationSelect) {

        destinationSelect.addEventListener("change", () => {

            if (typeof handleDestinationChange === "function") handleDestinationChange();

        });

    }

}



/*==========================================================
 SEGURO MÉDICO
 ----------------------------------------------------------
 El catálogo de planes se carga dinámicamente desde la hoja
 "Seguros" (columna A), igual filosofía que services.js con
 "Servicios Opcionales". El valor por semana de cada plan se
 resuelve más adelante, en pricing.js, según el tipo de
 cotización (Single/Couple/Family) elegido.
==========================================================*/

async function loadInsuranceOptions() {

    const options = await fetchInsuranceOptions();

    populateSelectOptions("insurance", options);

}

async function handleSearchLead() {

    const query = document.getElementById("search_email").value.trim();

    const statusBox = document.getElementById("leadStatus");

    if (!query) {

        statusBox.textContent = "Ingresa un correo electrónico o teléfono para buscar.";

        return;

    }

    statusBox.textContent = "Buscando lead en GoHighLevel...";

    hideQuotationHistory();

    const contact = await searchLeadByEmailOrPhone(query);

    if (contact) {

        applyLeadToForm(contact);

        statusBox.textContent = `Lead encontrado: ${contact.name || contact.email || query}.`;

        const previousQuotations = await getPreviousQuotations(contact.id);

        renderQuotationHistory(previousQuotations);

    } else {

        statusBox.textContent = "No se encontró ningún lead con esos datos. Puedes continuar creando uno nuevo.";

    }

}



/*==========================================================
 HISTORIAL DE COTIZACIONES PREVIAS DEL CONTACTO
 ----------------------------------------------------------
 Se muestra ANTES de generar una nueva cotización, para que el
 asesor pueda ver qué se le ha propuesto antes a este mismo
 estudiante y evitar duplicados innecesarios.
==========================================================*/

function renderQuotationHistory(quotations) {

    const box = document.getElementById("leadHistory");

    if (!box) return;

    if (!quotations || quotations.length === 0) {

        hideQuotationHistory();

        return;

    }

    const sorted = [...quotations].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const latest = sorted[0];

    const latestDate = latest.createdAt ? new Date(latest.createdAt).toLocaleDateString("es-CO") : "fecha desconocida";

    const latestTotal = latest.total !== undefined ? `${latest.currency || ""} $${Number(latest.total).toLocaleString("en-AU")}` : "-";

    box.textContent =

        `📋 ${quotations.length} cotización(es) previa(s) — más reciente: ${latestDate}, ` +

        `${latestTotal}, estado: ${latest.internal_status || "desconocido"}.`;

    box.classList.remove("hidden");

}

function hideQuotationHistory() {

    const box = document.getElementById("leadHistory");

    if (!box) return;

    box.textContent = "";

    box.classList.add("hidden");

}



/*==========================================================
 RELLENA EL FORMULARIO CON UN CONTACTO DE GHL
==========================================================*/

function applyLeadToForm(contact) {

    if (contact.name) document.getElementById("student_name").value = contact.name;

    if (contact.email) document.getElementById("student_email").value = contact.email;

    applyContactNationalityToForm(contact.nationality);

    applyContactCountryToForm(contact.country);

    applyContactPhoneToForm(contact.phone, contact.country);

    applyContactApplicationTypeToForm(contact.applicationType);

}

/*
    Mismo criterio que applyContactCountryToForm: si no calza (ej. GHL
    trae "onshore" en minúscula), se compara sin distinguir mayúsculas
    contra las dos únicas opciones válidas del select.
*/

function applyContactApplicationTypeToForm(rawApplicationType) {

    if (!rawApplicationType) return;

    const target = normalize(rawApplicationType);

    const select = document.getElementById("application_type");

    if (!select) return;

    const matched = Array.from(select.options).find(option => normalize(option.value) === target);

    if (matched) select.value = matched.value;

}

/*
    Mismo criterio que applyContactCountryToForm: si no calza contra
    ninguna opción conocida, el select NO se toca — queda con lo que la
    asesora ya haya elegido, siempre editable.
*/

function applyContactNationalityToForm(rawNationality) {

    const matched = findNationalityByName(rawNationality);

    if (!matched) return;

    const select = document.getElementById("student_nationality");

    if (select) select.value = matched;

}

/*
    Lead encontrado + country con valor -> se autoselecciona. Lead
    encontrado + country vacío -> el select NO se toca, queda con
    lo que la asesora ya haya elegido y sigue 100% editable.
*/

/*
    Inverso de findCountryByName: GHL espera el código ISO2 en su campo
    estándar "country" (ver applyContactCountryToForm) — se usa al
    enviar datos de vuelta a GHL (ver app.js#handleGenerateQuote), nunca
    para el resto de la lógica del cotizador (pricing.js sigue usando el
    nombre en español de #student_country, sin cambios).
*/

function countryNameToIso2(countryName) {

    const match = WORLD_COUNTRIES.find(country => country.name === countryName);

    return match ? match.iso2 : countryName;

}

function applyContactCountryToForm(rawCountry) {

    const matched = findCountryByName(rawCountry);

    if (!matched) return;

    const select = document.getElementById("student_country");

    if (select) select.value = matched.name;

}

/*
    Si GHL trae el teléfono en formato internacional (ej.
    "+57 3001234567"), se separa indicativo + número. Si no se
    pudo identificar el indicativo (formato ambiguo o sin "+") y
    el país del estudiante sí se resolvió, se usa el indicativo de
    ese país como valor INICIAL — nunca una regla fija, la asesora
    siempre puede corregirlo.
*/

function applyContactPhoneToForm(rawPhone, rawCountry) {

    if (!rawPhone) return;

    const parsed = parsePhoneNumber(rawPhone);

    const numberInput = document.getElementById("student_phone_number");

    if (numberInput) numberInput.value = parsed.number;

    const codeSelect = document.getElementById("student_phone_code");

    if (!codeSelect) return;

    if (parsed.dialCode) {

        codeSelect.value = parsed.dialCode;

        return;

    }

    const countryMatch = findCountryByName(rawCountry);

    if (countryMatch) codeSelect.value = countryMatch.dialCode;

}



/*==========================================================
 API PÚBLICA DEL MÓDULO
 ----------------------------------------------------------
 getStudentData() es el punto de integración con pricing.js:
 al presionar "Calcular Cotización", pricing.js llamará a
 esta función para leer los datos del estudiante, sin
 necesidad de tocar student.js.
==========================================================*/

function getStudentData() {

    const countryValue = document.getElementById("student_country").value;

    const phoneCode = document.getElementById("student_phone_code").value;

    const phoneNumber = document.getElementById("student_phone_number").value.trim();

    return {

        name: document.getElementById("student_name").value,

        email: document.getElementById("student_email").value,

        phone: [phoneCode, phoneNumber].filter(Boolean).join(" "),

        nationality: document.getElementById("student_nationality").value,

        /*
            Fuente final de verdad para pricing.js#calculateExtraCosts:
            siempre el select #student_country, sin importar si su
            valor llegó de GHL (lead search) o fue elegido a mano.
        */

        country: countryValue === "Seleccionar" ? "" : countryValue,

        destination: document.getElementById("destination").value,

        application_type: document.getElementById("application_type").value,

        application_number: Number(document.getElementById("application_number").value) || 1,

        quotation_type: document.getElementById("quotation_type").value,

        number_applicants: Number(document.getElementById("number_applicants").value) || 1,

        insurance: document.getElementById("insurance").value

    };

}