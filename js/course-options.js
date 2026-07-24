/*==========================================================
 LATINADVISOR
 COURSE OPTIONS MODULE (PESTAÑAS DE OPCIÓN DE COLEGIO)
 VERSION 1.0
 ----------------------------------------------------------
 Permite comparar varios colegios para el mismo estudiante:
 cada pestaña ("Opción 1", "Opción 2", ...) tiene su PROPIA
 sección de Cursos Académicos (ver js/courses.js, que ya
 escopea todas sus operaciones por optionId), pero comparte el
 resto de la cotización (estudiante, servicios, reglas
 generales) — eso lo resuelve pricing.js, no este módulo.

 Este módulo solo administra: qué opciones existen, cuál está
 activa, y la etiqueta visible de cada pestaña — siempre
 "Opción N" según su posición, sin importar el/los colegios
 elegidos dentro de ella (una misma opción puede combinar
 programas de distintas instituciones, ver js/pdf.js y
 js/summary.js para dónde se muestra cada institución).
==========================================================*/



/*==========================================================
 ESTADO DEL MÓDULO
==========================================================*/

let optionIdCounter = 0;

let courseOptions = []; // [{ id }]

let activeOptionId = null;



/*==========================================================
 CREA LA TARJETA "CURSOS ACADÉMICOS" CON SU BARRA DE PESTAÑAS
==========================================================*/

function createCoursesCard() {

    optionIdCounter = 0;

    courseOptions = [];

    const firstOptionId = createNewOptionEntry();

    activeOptionId = firstOptionId;

    const { html: coursesHtml, firstCourseId } = createCourseOptionCoursesMarkup(firstOptionId);

    const panelHtml = `

        <div class="option-panel" id="optionPanel-${firstOptionId}" data-option-id="${firstOptionId}">

            ${coursesHtml}

        </div>

    `;

    const html = `

        <div class="option-tabs-row">

            <div class="option-tabs" id="optionTabsBar">${renderOptionTabsBar()}</div>

            <button
                type="button"
                class="btn add-option-btn"
                onclick="addCourseOption()">

                ➕ Agregar opción de cotización

            </button>

        </div>

        <div id="optionPanels">${panelHtml}</div>

    `;

    /*
        Igual que createCoursesCard() en la versión anterior: el HTML
        aún no está insertado en el DOM (app.js concatena todas las
        tarjetas antes de asignarlas a app.innerHTML), así que la
        inicialización de la primera tarjeta se difiere al siguiente
        ciclo del event loop.
    */

    setTimeout(() => {

        initializeCourseCard(firstCourseId);

        updateDeleteButtonsVisibility(firstOptionId);

    }, 0);

    return createCard("Cursos Académicos", html, { id: "coursesCard", collapsible: true });

}



/*==========================================================
 CREA UNA NUEVA ENTRADA DE OPCIÓN (SIN TOCAR EL DOM)
==========================================================*/

function createNewOptionEntry() {

    optionIdCounter++;

    const id = optionIdCounter;

    courseOptions.push({ id });

    return id;

}



/*==========================================================
 AGREGAR OPCIÓN DE COTIZACIÓN (PESTAÑA NUEVA)
==========================================================*/

function addCourseOption() {

    const optionId = createNewOptionEntry();

    const { html: coursesHtml, firstCourseId } = createCourseOptionCoursesMarkup(optionId);

    const panelsContainer = document.getElementById("optionPanels");

    if (!panelsContainer) return;

    panelsContainer.insertAdjacentHTML("beforeend", `

        <div class="option-panel hidden" id="optionPanel-${optionId}" data-option-id="${optionId}">

            ${coursesHtml}

        </div>

    `);

    initializeCourseCard(firstCourseId);

    updateDeleteButtonsVisibility(optionId);

    switchToOption(optionId);

}



/*==========================================================
 ELIMINAR OPCIÓN DE COTIZACIÓN
 ----------------------------------------------------------
 Pide confirmación antes de borrar. Siempre debe permanecer al
 menos una opción — en ese caso el botón de borrar de la
 pestaña ya viene oculto (ver renderOptionTabButton) y aquí se
 bloquea igual por seguridad.
==========================================================*/

function removeCourseOption(optionId) {

    if (courseOptions.length <= 1) return;

    showConfirmModal({

        message: "¿Estás segura de que deseas eliminar esta opción de cotización?",

        confirmLabel: "Eliminar opción",

        cancelLabel: "Cancelar",

        onConfirm: () => {

            const index = courseOptions.findIndex(opt => opt.id === Number(optionId));

            if (index === -1) return;

            courseOptions.splice(index, 1);

            const panel = document.getElementById(`optionPanel-${optionId}`);

            if (panel) panel.remove();

            if (Number(activeOptionId) === Number(optionId)) {

                const fallback = courseOptions[Math.max(0, index - 1)];

                switchToOption(fallback.id);

            } else {

                refreshOptionTabsBar();

            }

        }

    });

}



/*==========================================================
 CAMBIAR DE PESTAÑA ACTIVA
==========================================================*/

function switchToOption(optionId) {

    activeOptionId = Number(optionId);

    document.querySelectorAll(".option-panel").forEach(panel => {

        panel.classList.toggle("hidden", Number(panel.dataset.optionId) !== activeOptionId);

    });

    refreshOptionTabsBar();

}



/*==========================================================
 RENDERIZADO DE LA BARRA DE PESTAÑAS
==========================================================*/

function renderOptionTabsBar() {

    return courseOptions.map((option, index) => renderOptionTabButton(option, index)).join("");

}

function refreshOptionTabsBar() {

    const bar = document.getElementById("optionTabsBar");

    if (bar) bar.innerHTML = renderOptionTabsBar();

}

function renderOptionTabButton(option, index) {

    const isActive = option.id === activeOptionId;

    const label = buildOptionLabel(option, index);

    const showDelete = courseOptions.length > 1;

    return `

        <div class="option-tab ${isActive ? "active" : ""}" data-option-id="${option.id}">

            <span class="option-tab-label" onclick="switchToOption(${option.id})">${label}</span>

            <button
                type="button"
                class="delete-option ${showDelete ? "" : "hidden"}"
                title="Eliminar opción"
                onclick="removeCourseOption(${option.id})">

                🗑

            </button>

        </div>

    `;

}

function buildOptionLabel(option, index) {

    return `Opción ${index + 1}`;

}



/*==========================================================
 API PÚBLICA DEL MÓDULO
 ----------------------------------------------------------
 getAllCourseOptionsData() es el punto de integración con
 pricing.js: una entrada por pestaña, con los cursos propios de
 esa pestaña (ver js/courses.js#getAllCoursesData).
==========================================================*/

function getAllCourseOptionsData() {

    return courseOptions.map((option, index) => ({

        optionId: option.id,

        optionLabel: buildOptionLabel(option, index),

        courses: getAllCoursesData(option.id)

    }));

}
