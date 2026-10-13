/*==========================================================
 LATINADVISOR
 SERVICES MODULE
 VERSION 2.0 — POR OPCIÓN DE COLEGIO
 ----------------------------------------------------------
 Servicios opcionales (Airport Pickup, SIM Card, y cualquier
 otro que se agregue después). El catálogo NUNCA se
 hardcodea: se carga dinámicamente desde database.js
 (fetchServiceCatalog(), hoja "Servicios Opcionales"), igual
 filosofía que courses.js con Colegio/Ciudad/Tipo/Programa.

 Decisión confirmada del cliente, 2026-10-12: Servicios
 Opcionales dejó de ser un selector único y global para toda la
 cotización — ahora cada opción de colegio (pestaña) tiene su
 PROPIA sección de Servicios Opcionales, con su propia selección
 y su propio cálculo (ver pricing.js#calculateOptionQuote). Por
 eso TODAS las funciones de este módulo reciben "optionId" y
 escopan sus ids/selectores con él, exactamente igual que
 courses.js escopa por "id" de curso dentro de cada opción —
 nunca se lee ni se toca el servicio de otra pestaña.
==========================================================*/



/*==========================================================
 CREA LA SECCIÓN DE SERVICIOS DE UNA OPCIÓN (MARKUP)
 ----------------------------------------------------------
 Se inserta DENTRO del panel de esa opción (ver
 course-options.js#createCoursesCard/addCourseOption), como una
 tarjeta anidada más — nunca como tarjeta propia de nivel
 superior.
==========================================================*/

function createServicesMarkup(optionId) {

    const html = `

        <div
            id="servicesContainer-${optionId}"
            class="form-grid">

            <div class="placeholder">

                Cargando servicios disponibles...

            </div>

        </div>

    `;

    return createCard("Servicios Opcionales", html, { id: `servicesCard-${optionId}`, collapsible: true });

}



/*==========================================================
 CARGA EL CATÁLOGO DE SERVICIOS DESDE LA BASE DE DATOS
==========================================================*/

async function loadServiceOptions(optionId) {

    const catalog = await fetchServiceCatalog();

    const container = document.getElementById(`servicesContainer-${optionId}`);

    if (!container) return;

    const catalogHtml = catalog.length > 0
        ? catalog.map(service => createServiceOption(service, optionId)).join("")
        : `<div class="placeholder">Aún no hay servicios configurados en la base de datos.</div>`;

    // "Servicio extra" NO viene de la base de datos (ver
    // createCustomServiceOption más abajo) — se muestra siempre, haya
    // o no catálogo configurado, para que la asesora pueda cobrar
    // cualquier concepto puntual sin depender de que alguien lo agregue
    // primero a la hoja "Servicios Opcionales".
    container.innerHTML = catalogHtml + createCustomServiceOption(optionId);

    wireServiceOptionEvents(optionId);

}



/*==========================================================
 CREA UNA OPCIÓN DE SERVICIO (checkbox + cantidad)
==========================================================*/

function createServiceOption(service, optionId) {

    return `

    <div
        class="form-group service-option"
        data-service-code="${service.code}">

        <label for="service_check_${optionId}_${service.code}">

            <input
                type="checkbox"
                class="service-checkbox"
                id="service_check_${optionId}_${service.code}">

            ${service.label}

        </label>

        <input
            type="number"
            class="service-quantity"
            id="service_qty_${optionId}_${service.code}"
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

function createCustomServiceOption(optionId) {

    return `

    <div
        class="form-group service-option"
        data-service-code="${CUSTOM_SERVICE_CODE}">

        <label for="service_check_${optionId}_${CUSTOM_SERVICE_CODE}">

            <input
                type="checkbox"
                class="service-checkbox"
                id="service_check_${optionId}_${CUSTOM_SERVICE_CODE}">

            Servicio extra

        </label>

    </div>

    <div class="custom-service-fields manual-fields form-grid hidden" id="customServiceFields-${optionId}">

        <div class="form-group">

            <label for="custom_service_description_${optionId}">Descripción del servicio</label>

            <input
                type="text"
                id="custom_service_description_${optionId}"
                placeholder="Ej: Emitir COE, servicio extra del colegio">

        </div>

        <div class="form-group">

            <label for="custom_service_value_${optionId}">Valor (AUD)</label>

            <input
                type="number"
                id="custom_service_value_${optionId}"
                min="0"
                step="0.01"
                placeholder="0.00">

        </div>

    </div>

    `;

}

function toggleCustomServiceFields(show, optionId) {

    const fields = document.getElementById(`customServiceFields-${optionId}`);

    if (fields) fields.classList.toggle("hidden", !show);

}

/*==========================================================
 HABILITA/DESHABILITA LA CANTIDAD SEGÚN EL CHECKBOX
==========================================================*/

function wireServiceOptionEvents(optionId) {

    const container = document.getElementById(`servicesContainer-${optionId}`);

    if (!container) return;

    container.querySelectorAll(".service-checkbox").forEach(checkbox => {

        checkbox.addEventListener("change", () => {

            const optionGroup = checkbox.closest(".service-option");

            const code = optionGroup ? optionGroup.dataset.serviceCode : "";

            if (code === CUSTOM_SERVICE_CODE) {

                toggleCustomServiceFields(checkbox.checked, optionId);

                return;

            }

            const quantityInput = document.getElementById(`service_qty_${optionId}_${code}`);

            if (quantityInput) quantityInput.disabled = !checkbox.checked;

        });

    });

}



/*==========================================================
 API PÚBLICA DEL MÓDULO
 ----------------------------------------------------------
 getSelectedServices(optionId) es el punto de integración con
 pricing.js (vía course-options.js#getAllCourseOptionsData): al
 presionar "Calcular Cotización", pricing.js llama a esta función
 UNA vez por opción, para saber qué servicios opcionales fueron
 seleccionados y en qué cantidad EN ESA opción puntual.
==========================================================*/

function getSelectedServices(optionId) {

    const container = document.getElementById(`servicesContainer-${optionId}`);

    if (!container) return [];

    const selected = [];

    container.querySelectorAll(".service-checkbox:checked").forEach(checkbox => {

        const optionGroup = checkbox.closest(".service-option");

        const serviceCode = optionGroup ? optionGroup.dataset.serviceCode : "";

        if (serviceCode === CUSTOM_SERVICE_CODE) {

            const descriptionInput = document.getElementById(`custom_service_description_${optionId}`);

            const valueInput = document.getElementById(`custom_service_value_${optionId}`);

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

        const quantityInput = document.getElementById(`service_qty_${optionId}_${serviceCode}`);

        const quantity = Number(quantityInput ? quantityInput.value : 1) || 1;

        selected.push({ serviceCode, quantity });

    });

    return selected;

}
