/*==========================================================
 LATINADVISOR
 SERVICES MODULE
 VERSION 1.0
 ----------------------------------------------------------
 Servicios opcionales (Airport Pickup, SIM Card, y cualquier
 otro que se agregue después). El catálogo NUNCA se
 hardcodea: se carga dinámicamente desde database.js
 (fetchServiceCatalog(), hoja "Servicios Opcionales"), igual
 filosofía que courses.js con Colegio/Ciudad/Tipo/Programa.
==========================================================*/



/*==========================================================
 CREA EL MÓDULO DE SERVICIOS
==========================================================*/

function createServicesCard() {

    const html = `

        <div
            id="servicesContainer"
            class="form-grid">

            <div class="placeholder">

                Cargando servicios disponibles...

            </div>

        </div>

    `;

    /*
        El contenedor aún no está en el DOM en este punto: se
        difiere la carga del catálogo al siguiente ciclo del
        event loop, igual que en courses.js y student.js.
    */

    setTimeout(() => {

        loadServiceOptions();

    }, 0);

    return createCard("Servicios Opcionales", html, { id: "servicesCard", collapsible: true });

}



/*==========================================================
 CARGA EL CATÁLOGO DE SERVICIOS DESDE LA BASE DE DATOS
==========================================================*/

async function loadServiceOptions() {

    const catalog = await fetchServiceCatalog();

    const container = document.getElementById("servicesContainer");

    if (!container) return;

    const catalogHtml = catalog.length > 0
        ? catalog.map(createServiceOption).join("")
        : `<div class="placeholder">Aún no hay servicios configurados en la base de datos.</div>`;

    // "Servicio extra" NO viene de la base de datos (ver
    // createCustomServiceOption más abajo) — se muestra siempre, haya
    // o no catálogo configurado, para que la asesora pueda cobrar
    // cualquier concepto puntual sin depender de que alguien lo agregue
    // primero a la hoja "Servicios Opcionales".
    container.innerHTML = catalogHtml + createCustomServiceOption();

    wireServiceOptionEvents();

}



/*==========================================================
 CREA UNA OPCIÓN DE SERVICIO (checkbox + cantidad)
==========================================================*/

function createServiceOption(service) {

    return `

    <div
        class="form-group service-option"
        data-service-code="${service.code}">

        <label for="service_check_${service.code}">

            <input
                type="checkbox"
                class="service-checkbox"
                id="service_check_${service.code}">

            ${service.label}

        </label>

        <input
            type="number"
            class="service-quantity"
            id="service_qty_${service.code}"
            min="1"
            step="1"
            value="1"
            disabled>

    </div>

    `;

}



/*==========================================================
 SERVICIO EXTRA (concepto libre, sin catálogo)
 ----------------------------------------------------------
 Único servicio del listado que no viene de la hoja "Servicios
 Opcionales": la asesora escribe a mano la descripción y el valor
 en AUD para cobrar cualquier concepto puntual (solicitud de COE,
 courier de documentos, traducción adicional, etc.) sin necesidad
 de agregarlo antes a la base de datos — ver getSelectedServices()
 y pricing.js#calculateServicesLines (rama isCustom) más abajo.
==========================================================*/

const CUSTOM_SERVICE_CODE = "custom";

function createCustomServiceOption() {

    return `

    <div
        class="form-group service-option"
        data-service-code="${CUSTOM_SERVICE_CODE}">

        <label for="service_check_${CUSTOM_SERVICE_CODE}">

            <input
                type="checkbox"
                class="service-checkbox"
                id="service_check_${CUSTOM_SERVICE_CODE}">

            Servicio extra

        </label>

    </div>

    <div class="custom-service-fields manual-fields form-grid hidden" id="customServiceFields">

        <div class="form-group">

            <label for="custom_service_description">Descripción del servicio</label>

            <input
                type="text"
                id="custom_service_description"
                placeholder="Ej: Emitir COE, servicio extra del colegio">

        </div>

        <div class="form-group">

            <label for="custom_service_value">Valor (AUD)</label>

            <input
                type="number"
                id="custom_service_value"
                min="0"
                step="0.01"
                placeholder="0.00">

        </div>

    </div>

    `;

}

function toggleCustomServiceFields(show) {

    const fields = document.getElementById("customServiceFields");

    if (fields) fields.classList.toggle("hidden", !show);

}

/*==========================================================
 HABILITA/DESHABILITA LA CANTIDAD SEGÚN EL CHECKBOX
==========================================================*/

function wireServiceOptionEvents() {

    document.querySelectorAll(".service-checkbox").forEach(checkbox => {

        checkbox.addEventListener("change", () => {

            const container = checkbox.closest(".service-option");

            const code = container ? container.dataset.serviceCode : "";

            if (code === CUSTOM_SERVICE_CODE) {

                toggleCustomServiceFields(checkbox.checked);

                return;

            }

            const quantityInput = document.getElementById(`service_qty_${code}`);

            if (quantityInput) quantityInput.disabled = !checkbox.checked;

        });

    });

}



/*==========================================================
 API PÚBLICA DEL MÓDULO
 ----------------------------------------------------------
 getSelectedServices() es el punto de integración con
 pricing.js: al presionar "Calcular Cotización", pricing.js
 llamará a esta función para saber qué servicios opcionales
 fueron seleccionados y en qué cantidad.
==========================================================*/

function getSelectedServices() {

    const selected = [];

    document.querySelectorAll(".service-checkbox:checked").forEach(checkbox => {

        const container = checkbox.closest(".service-option");

        const serviceCode = container ? container.dataset.serviceCode : "";

        if (serviceCode === CUSTOM_SERVICE_CODE) {

            const descriptionInput = document.getElementById("custom_service_description");

            const valueInput = document.getElementById("custom_service_value");

            const description = descriptionInput ? descriptionInput.value.trim() : "";

            // Sin descripción no hay nada que mostrarle al cliente en el
            // PDF — se omite en vez de agregar una fila "Servicio extra"
            // sin identificar (mismo criterio que el Modo Manual de
            // courses.js: un campo vacío simplemente no aplica).
            if (!description) return;

            const value = Number(valueInput ? valueInput.value : 0) || 0;

            selected.push({ serviceCode, quantity: 1, isCustom: true, customLabel: description, customValue: value });

            return;

        }

        const quantityInput = document.getElementById(`service_qty_${serviceCode}`);

        const quantity = Number(quantityInput ? quantityInput.value : 1) || 1;

        selected.push({ serviceCode, quantity });

    });

    return selected;

}
