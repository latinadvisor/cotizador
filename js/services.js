/*==========================================================
 LATINADVISOR
 SERVICES MODULE
 VERSION 1.0
 ----------------------------------------------------------
 Servicios opcionales (Airport Pickup, SIM Card, y cualquier
 otro que se agregue después). El catálogo NUNCA se
 hardcodea: se carga dinámicamente desde database.js
 (fetchServiceCatalog(), hoja "Servicios Opcionales"), igual
 filosofía que courses.js con Colegio/Ciudad/Subtipo/Programa.
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

    if (catalog.length === 0) {

        container.innerHTML = `

            <div class="placeholder">

                Aún no hay servicios configurados en la base de datos.

            </div>

        `;

        return;

    }

    container.innerHTML = catalog.map(createServiceOption).join("");

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
 HABILITA/DESHABILITA LA CANTIDAD SEGÚN EL CHECKBOX
==========================================================*/

function wireServiceOptionEvents() {

    document.querySelectorAll(".service-checkbox").forEach(checkbox => {

        checkbox.addEventListener("change", () => {

            const container = checkbox.closest(".service-option");

            const code = container ? container.dataset.serviceCode : "";

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

        const quantityInput = document.getElementById(`service_qty_${serviceCode}`);

        const quantity = Number(quantityInput ? quantityInput.value : 1) || 1;

        selected.push({ serviceCode, quantity });

    });

    return selected;

}
