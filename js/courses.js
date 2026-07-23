/*==========================================================
 LATINADVISOR
 COURSES MODULE
 VERSION 3.0
 ----------------------------------------------------------
 Este módulo maneja las tarjetas de curso DENTRO de un panel
 de opción de colegio (ver js/course-options.js, que crea y
 administra las pestañas "Opción 1"/"Opción 2"/...). Todas las
 funciones públicas reciben un "optionId" y escopean sus
 querySelector al contenedor #coursesContainer-{optionId} de
 esa pestaña — nunca leen ni tocan cursos de otra pestaña.
==========================================================*/

/*==========================================================
 ESTADO DEL MÓDULO

 "courseIdCounter" genera identificadores únicos y crecientes
 para cada tarjeta de curso EN TODA LA APP (todas las pestañas
 comparten el mismo contador). Los identificadores nunca se
 reutilizan, incluso si se eliminan tarjetas intermedias.
==========================================================*/

let courseIdCounter = 0;



/*==========================================================
 CONSTANTES DE NEGOCIO

 ELICOS/VET/HE es el único universo posible de valores (regla
 fija del negocio), pero cuáles de esos tres se OFRECEN para
 un colegio+ciudad específico, y todos los demás SELECT
 (Colegio, Ciudad, Subtipo, Programa), se consultan siempre a
 database.js — el único módulo que habla con Google Sheets.
==========================================================*/



/*==========================================================
 CREA EL MARKUP DE CURSOS DE UNA OPCIÓN (PESTAÑA)
 ----------------------------------------------------------
 Devuelve el HTML del contenedor de cursos + botón "Agregar
 otro curso" para UNA pestaña, junto con el id de la primera
 tarjeta creada (para que el llamador la inicialice una vez
 esté en el DOM). No reinicia "courseIdCounter": cada opción
 nueva recibe ids de curso siempre crecientes.
==========================================================*/

function createCourseOptionCoursesMarkup(optionId) {

    courseIdCounter++;

    const firstCourseId = courseIdCounter;

    const html = `

        <div id="coursesContainer-${optionId}">

            ${createCourseCard(firstCourseId, optionId)}

        </div>

        <div class="add-course-container">

            <button
                type="button"
                class="btn add-course-btn"
                onclick="addCourse(${optionId})">

                ➕ Agregar otro curso

            </button>

        </div>

    `;

    return { html, firstCourseId };

}



/*==========================================================
 CREA UNA TARJETA DE CURSO
==========================================================*/

function createCourseCard(id, optionId) {

    return `

    <div
        class="course-card"
        id="course-${id}"
        data-course-id="${id}"
        data-option-id="${optionId}">

        <div class="course-header">

            <h3 class="course-title">

                📚 Curso #${id}

            </h3>

            <button
                type="button"
                class="delete-course"
                title="Eliminar curso"
                onclick="removeCourse(${optionId}, ${id})">

                🗑

            </button>

        </div>

        <div class="form-grid">

            ${createSelect({

                label:"Colegio",

                id:`college_${id}`,

                options:["Seleccionar"]

            })}

            ${createSelect({

                label:"Ciudad",

                id:`city_${id}`,

                options:["Seleccionar"]

            })}

            ${createSelect({

                label:"Tipo de Curso",

                id:`course_type_${id}`,

                options:["Seleccionar"]

            })}

            ${createSelect({

                label:"Subtipo",

                id:`course_subtype_${id}`,

                options:["Seleccionar"]

            })}

            ${createSelect({

                label:"Programa",

                id:`program_${id}`,

                options:["Seleccionar"]

            })}

            ${createWeeksField(id)}

        </div>

    </div>

    `;

}



/*==========================================================
 CAMPO "DURACIÓN (SEMANAS)"
 ----------------------------------------------------------
 Se construye por fuera de createInput() porque necesita ser
 ocultado/mostrado como un todo (label + input) según el Tipo
 de Curso, sin modificar ui.js.
==========================================================*/

function createWeeksField(id) {

    return `

    <div
        class="form-group"
        id="weeksField_${id}">

        <label for="weeks_${id}">

            Duración (Semanas)

        </label>

        <input
            id="weeks_${id}"
            type="number"
            min="1"
            max="52"
            step="1"
            placeholder="Ej: 12">

    </div>

    `;

}



/*==========================================================
 INICIALIZA UNA TARJETA RECIÉN INSERTADA EN EL DOM
==========================================================*/

async function initializeCourseCard(id) {

    attachCourseCardEvents(id);

    toggleWeeksField(id, "");

    const colleges = await fetchColleges(getCurrentDestination());

    populateSelectOptions(`college_${id}`, colleges);

}



/*==========================================================
 DESTINO ACTUAL (seleccionado en la tarjeta del estudiante)
==========================================================*/

function getCurrentDestination() {

    const destinationSelect = document.getElementById("destination");

    return destinationSelect ? destinationSelect.value : "";

}



/*==========================================================
 CAMBIO DE DESTINO: refresca el Colegio de TODAS las tarjetas
 de curso ya creadas, EN TODAS LAS PESTAÑAS, y reinicia la
 cascada de cada una (un colegio de otro destino ya no es una
 selección válida). El destino es información de NIVEL 1
 (compartida por todas las opciones de colegio).
==========================================================*/

async function handleDestinationChange() {

    const destination = getCurrentDestination();

    const colleges = await fetchColleges(destination);

    document.querySelectorAll(".course-card").forEach(card => {

        const id = card.dataset.courseId;

        populateSelectOptions(`college_${id}`, colleges);

        resetSelect(`city_${id}`);

        resetSelect(`course_type_${id}`);

        resetSelect(`course_subtype_${id}`);

        resetSelect(`program_${id}`);

        toggleWeeksField(id, "");

    });

}



/*==========================================================
 CONECTA LOS EVENTOS DE CASCADA DE UNA TARJETA
 ----------------------------------------------------------
 Se usa addEventListener en lugar de atributos "onchange" en
 el HTML porque createSelect() (ui.js) no expone ese parámetro
 y no queremos modificar ui.js para este módulo.
==========================================================*/

function attachCourseCardEvents(id) {

    document

        .getElementById(`college_${id}`)

        .addEventListener("change", () => handleCollegeChange(id));

    document

        .getElementById(`city_${id}`)

        .addEventListener("change", () => handleCityChange(id));

    document

        .getElementById(`course_type_${id}`)

        .addEventListener("change", () => handleCourseTypeChange(id));

    document

        .getElementById(`course_subtype_${id}`)

        .addEventListener("change", () => handleSubtypeChange(id));

}



/*==========================================================
 UTILIDADES DE SELECT DINÁMICO
==========================================================*/

function populateSelectOptions(selectId, options, placeholder = "Seleccionar") {

    const select = document.getElementById(selectId);

    if (!select) return;

    select.innerHTML = "";

    const placeholderOption = document.createElement("option");

    placeholderOption.value = "";

    placeholderOption.textContent = placeholder;

    select.appendChild(placeholderOption);

    options.forEach(optionValue => {

        const option = document.createElement("option");

        option.value = optionValue;

        option.textContent = optionValue;

        select.appendChild(option);

    });

}

function resetSelect(selectId, placeholder = "Seleccionar") {

    populateSelectOptions(selectId, [], placeholder);

}



/*==========================================================
 CASCADA: COLEGIO -> CIUDAD
==========================================================*/

async function handleCollegeChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    resetSelect(`city_${id}`);

    resetSelect(`course_type_${id}`);

    resetSelect(`course_subtype_${id}`);

    resetSelect(`program_${id}`);

    toggleWeeksField(id, "");

    if (!college) return;

    const cities = await fetchCitiesByCollege(college);

    populateSelectOptions(`city_${id}`, cities);

}



/*==========================================================
 CASCADA: CIUDAD -> TIPO DE CURSO
==========================================================*/

async function handleCityChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    const city = document.getElementById(`city_${id}`).value;

    resetSelect(`course_type_${id}`);

    resetSelect(`course_subtype_${id}`);

    resetSelect(`program_${id}`);

    toggleWeeksField(id, "");

    if (!college || !city) return;

    const types = await fetchCourseTypesByCollegeAndCity({ college, city });

    populateSelectOptions(`course_type_${id}`, types);

}



/*==========================================================
 CASCADA: TIPO -> SUBTIPO -> PROGRAMA
 Y VISIBILIDAD DE DURACIÓN (SOLO ELICOS)
==========================================================*/

async function handleCourseTypeChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    const city = document.getElementById(`city_${id}`).value;

    const type = document.getElementById(`course_type_${id}`).value;

    toggleWeeksField(id, type);

    resetSelect(`course_subtype_${id}`);

    resetSelect(`program_${id}`);

    if (!type) return;

    const subtypes = await fetchSubtypesByCourseSelection({ college, city, type });

    populateSelectOptions(`course_subtype_${id}`, subtypes);

}

async function handleSubtypeChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    const city = document.getElementById(`city_${id}`).value;

    const type = document.getElementById(`course_type_${id}`).value;

    const subtype = document.getElementById(`course_subtype_${id}`).value;

    resetSelect(`program_${id}`);

    if (!type || !subtype) return;

    const programs = await fetchProgramsByCourseSelection({ college, city, type, subtype });

    populateSelectOptions(`program_${id}`, programs);

}

function toggleWeeksField(id, type) {

    const field = document.getElementById(`weeksField_${id}`);

    if (!field) return;

    if (type === "ELICOS") {

        field.classList.remove("hidden");

    } else {

        field.classList.add("hidden");

        document.getElementById(`weeks_${id}`).value = "";

    }

}



/*==========================================================
 AGREGAR CURSO (dentro de la pestaña "optionId")
==========================================================*/

function addCourse(optionId) {

    courseIdCounter++;

    const id = courseIdCounter;

    const container = document.getElementById(`coursesContainer-${optionId}`);

    if (!container) return;

    container.insertAdjacentHTML("beforeend", createCourseCard(id, optionId));

    initializeCourseCard(id);

    updateDeleteButtonsVisibility(optionId);

    renumberCourseTitles(optionId);

}



/*==========================================================
 ELIMINAR CURSO
 ----------------------------------------------------------
 Pide confirmación antes de borrar. Siempre debe permanecer al
 menos un curso por pestaña — en ese caso el botón de borrar ya
 viene oculto (ver updateDeleteButtonsVisibility) y aquí se
 bloquea igual por seguridad.
==========================================================*/

function removeCourse(optionId, id) {

    const container = document.getElementById(`coursesContainer-${optionId}`);

    if (!container) return;

    const totalCards = container.querySelectorAll(".course-card").length;

    if (totalCards <= 1) return;

    showConfirmModal({

        message: "¿Estás segura de que deseas eliminar este curso?",

        confirmLabel: "Eliminar curso",

        cancelLabel: "Cancelar",

        onConfirm: () => {

            const card = document.getElementById(`course-${id}`);

            if (card) card.remove();

            updateDeleteButtonsVisibility(optionId);

            renumberCourseTitles(optionId);

        }

    });

}



/*==========================================================
 MUESTRA/OCULTA EL BOTÓN ELIMINAR SEGÚN LA CANTIDAD DE CURSOS
 DE ESA PESTAÑA
==========================================================*/

function updateDeleteButtonsVisibility(optionId) {

    const container = document.getElementById(`coursesContainer-${optionId}`);

    if (!container) return;

    const cards = container.querySelectorAll(".course-card");

    cards.forEach(card => {

        const deleteButton = card.querySelector(".delete-course");

        if (!deleteButton) return;

        deleteButton.classList.toggle("hidden", cards.length <= 1);

    });

}



/*==========================================================
 RENUMERA LOS TÍTULOS "Curso #N" SEGÚN EL ORDEN VISUAL DENTRO
 DE ESA PESTAÑA
==========================================================*/

function renumberCourseTitles(optionId) {

    const container = document.getElementById(`coursesContainer-${optionId}`);

    if (!container) return;

    const cards = container.querySelectorAll(".course-card");

    cards.forEach((card, index) => {

        const title = card.querySelector(".course-title");

        if (title) title.textContent = `📚 Curso #${index + 1}`;

    });

}



/*==========================================================
 API PÚBLICA DEL MÓDULO
 ----------------------------------------------------------
 getAllCoursesData(optionId) es el punto de integración con
 pricing.js/course-options.js: devuelve SOLO los cursos de la
 pestaña indicada, nunca los de otras opciones.
==========================================================*/

function getAllCoursesData(optionId) {

    const container = document.getElementById(`coursesContainer-${optionId}`);

    if (!container) return [];

    const cards = container.querySelectorAll(".course-card");

    const courses = [];

    cards.forEach(card => {

        const id = card.dataset.courseId;

        courses.push({

            id,

            college: document.getElementById(`college_${id}`).value,

            city: document.getElementById(`city_${id}`).value,

            type: document.getElementById(`course_type_${id}`).value,

            subtype: document.getElementById(`course_subtype_${id}`).value,

            program: document.getElementById(`program_${id}`).value,

            weeks: document.getElementById(`weeks_${id}`).value

        });

    });

    return courses;

}
