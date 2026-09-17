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
 (Colegio, Ciudad, Programa), se consultan siempre a
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

            <div class="course-header-actions">

                <button
                    type="button"
                    class="manual-course-btn"
                    id="manualToggle_${id}"
                    title="Ingresar valores manualmente para este curso"
                    onclick="toggleManualOverride(${id})">

                    ✏️ Manual

                </button>

                <button
                    type="button"
                    class="delete-course"
                    title="Eliminar curso"
                    onclick="removeCourse(${optionId}, ${id})">

                    🗑

                </button>

            </div>

        </div>

        <div class="form-grid">

            ${createSelect({

                label:"Colegio",

                id:`college_${id}`,

                options:["Seleccionar"]

            })}

            ${createExistingStudentField(id)}

            ${createSelect({

                label:"Ciudad",

                id:`city_${id}`,

                options:["Seleccionar"]

            })}

            ${createStudentCityField(id)}

            ${createSelect({

                label:"Tipo de Curso",

                id:`course_type_${id}`,

                options:["Seleccionar"]

            })}

            ${createSelect({

                label:"Programa",

                id:`program_${id}`,

                options:["Seleccionar"]

            })}

            ${createScheduleField(id)}

            ${createWeeksField(id)}

        </div>

        ${createManualOverrideFields(id)}

    </div>

    `;

}



/*==========================================================
 CAMPO "¿ES ESTUDIANTE DE LA INSTITUCIÓN?" (SOLO ONSHORE)
 ----------------------------------------------------------
 Igual filosofía que createWeeksField(): se construye por fuera
 de createSelect() porque necesita ocultarse/mostrarse como un
 todo, esta vez según el Tipo de Aplicación (Onshore/Offshore)
 del estudiante, no según el curso — ver toggleExistingStudentField()
 y student.js (el select #application_type dispara el refresco
 en TODAS las tarjetas de curso, de todas las opciones).

 Si es Onshore y la asesora marca "Sí", la matrícula de ESE
 colegio queda en $0 (ver pricing.js#applyInstitutionEnrollmentFeeRule)
 — el estudiante ya pertenece a la institución.
==========================================================*/

function createExistingStudentField(id) {

    return `

    <div
        class="form-group hidden"
        id="existingStudentField_${id}">

        <label for="existing_student_${id}">

            ¿Es estudiante de la institución?

        </label>

        <select id="existing_student_${id}">

            <option value="No">No</option>

            <option value="Sí">Sí</option>

        </select>

    </div>

    `;

}

function toggleExistingStudentField(id, applicationType) {

    const field = document.getElementById(`existingStudentField_${id}`);

    if (!field) return;

    field.classList.toggle("hidden", applicationType !== "Onshore");

}

/*
    Refresca la visibilidad en TODAS las tarjetas de curso de TODAS las
    opciones — llamado desde student.js cuando cambia #application_type.
*/

function refreshExistingStudentFieldsVisibility() {

    const applicationType = getCurrentApplicationType();

    document.querySelectorAll(".course-card").forEach(card => {

        toggleExistingStudentField(card.dataset.courseId, applicationType);

    });

}

function getCurrentApplicationType() {

    const select = document.getElementById("application_type");

    return select ? select.value : "";

}



/*==========================================================
 CAMPO "CIUDAD SELECCIONADA POR EL ESTUDIANTE"
 ----------------------------------------------------------
 Oculto por defecto. Solo se muestra cuando la asesora elige
 "Todos los campus" en el select de Ciudad (ver
 toggleStudentCityField/handleCityChange): en ese caso "Ciudad"
 dejó de significar "dónde estudia" (es solo la condición que le
 dice al sistema que ese curso no varía de precio entre campus,
 ver database.js#matchesCityFilter) y hace falta registrar aparte
 en qué ciudad concreta quiere estudiar el estudiante, para que
 el PDF muestre esa ciudad en vez de "Todos los campus" (ver
 database.js#resolveCourseDisplayCity). Es un select (no texto
 libre) para evitar errores de tipeo — las opciones salen de
 database.js#fetchAllEnabledCities.
==========================================================*/

function createStudentCityField(id) {

    return `

    <div
        class="form-group hidden"
        id="studentCityField_${id}">

        <label for="student_city_${id}">

            Ciudad seleccionada por el estudiante

        </label>

        <select id="student_city_${id}">

            <option value="">Seleccionar</option>

        </select>

    </div>

    `;

}

async function toggleStudentCityField(id, city) {

    const field = document.getElementById(`studentCityField_${id}`);

    if (!field) return;

    if (city !== ALL_CITIES_OPTION) {

        field.classList.add("hidden");

        document.getElementById(`student_city_${id}`).value = "";

        return;

    }

    field.classList.remove("hidden");

    const cities = await fetchAllEnabledCities();

    populateSelectOptions(`student_city_${id}`, cities, "Seleccionar ciudad");

}

/*==========================================================
 CAMPO "HORARIO DE ESTUDIO" (Mañana/Tarde/Noche/No aplica)
 ----------------------------------------------------------
 Obligatorio para TODOS los cursos, sin importar el Tipo de
 Aplicación (a diferencia de "¿Es estudiante de la institución?",
 que solo aplica en Onshore). El precio base del curso puede
 variar según este valor — ver database.js#resolveWeeklyRate —
 y también es uno de los criterios de coincidencia del Motor de
 Promociones (database.js#evaluatePromotionsForCourse).

 "No aplica" es para programas (típicamente VET/HE) que no
 manejan horarios — con ese valor, resolveWeeklyRate no
 encuentra columna "Valor semana No aplica" y cae directo a
 "Valor semana" general, exactamente igual que si el curso no
 tuviera tarifas diferenciadas por horario. No requiere ningún
 caso especial en database.js.
==========================================================*/

function createScheduleField(id) {

    return `

    <div class="form-group" id="scheduleField_${id}">

        <label for="schedule_${id}">

            Horario de estudio

        </label>

        <select id="schedule_${id}">

            <option value="">Seleccionar</option>

            <option value="Mañana">Mañana</option>

            <option value="Tarde">Tarde</option>

            <option value="Noche">Noche</option>

            <option value="No aplica">No aplica</option>

        </select>

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
 CAMPOS "MANUAL" (SOBRESCRITURA DE VALORES ECONÓMICOS)
 ----------------------------------------------------------
 Ocultos por defecto. Al activarse con toggleManualOverride(),
 los valores aquí ingresados tienen prioridad sobre los del
 curso seleccionado SOLO para precio/matrícula/materiales/
 semanas — ver pricing.js#calculateCourseLine. El resto de la
 información del curso (colegio, tipo, programa,
 descuentos, etc.) sigue viniendo de la base de datos sin
 cambios.
==========================================================*/

function createManualOverrideFields(id) {

    return `

    <div class="manual-fields form-grid hidden" id="manualFields_${id}">

        <div class="form-group">

            <label for="manual_price_${id}">Valor del curso</label>

            <input
                id="manual_price_${id}"
                type="number"
                min="0"
                step="0.01"
                placeholder="Ej: 5000">

        </div>

        <div class="form-group">

            <label for="manual_enrollment_${id}">Valor de la matrícula</label>

            <input
                id="manual_enrollment_${id}"
                type="number"
                min="0"
                step="0.01"
                placeholder="Ej: 200">

        </div>

        <div class="form-group">

            <label for="manual_materials_${id}">Valor de materiales</label>

            <input
                id="manual_materials_${id}"
                type="number"
                min="0"
                step="0.01"
                placeholder="Ej: 150">

        </div>

        <div class="form-group">

            <label for="manual_weeks_${id}">Tiempo de estudio (semanas)</label>

            <input
                id="manual_weeks_${id}"
                type="number"
                min="1"
                max="208"
                step="1"
                placeholder="Ej: 12">

        </div>

    </div>

    `;

}

/*
    Activa/desactiva el modo Manual de una tarjeta. No borra los valores
    ingresados al desactivarlo (por si la asesora lo vuelve a activar),
    simplemente deja de usarlos — ver getAllCoursesData() más abajo.
*/

function toggleManualOverride(id) {

    const button = document.getElementById(`manualToggle_${id}`);

    const fields = document.getElementById(`manualFields_${id}`);

    if (!button || !fields) return;

    const isActive = !button.classList.contains("active");

    button.classList.toggle("active", isActive);

    fields.classList.toggle("hidden", !isActive);

}



/*==========================================================
 INICIALIZA UNA TARJETA RECIÉN INSERTADA EN EL DOM
==========================================================*/

async function initializeCourseCard(id) {

    attachCourseCardEvents(id);

    toggleWeeksField(id, "");

    toggleExistingStudentField(id, getCurrentApplicationType());

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

    await toggleStudentCityField(id, "");

    resetSelect(`course_type_${id}`);

    resetSelect(`program_${id}`);

    toggleWeeksField(id, "");

    if (!college) return;

    const cities = await fetchCitiesByCollege(college);

    populateSelectOptions(`city_${id}`, cities);

    if (cities.length === 0) {

        // Este colegio no tiene NINGUNA fila cargada en "Cursos" (catálogo
        // incompleto). Si tuviera aunque sea una fila con Ciudad vacía,
        // fetchCitiesByCollege ya habría incluido la opción "Todos los
        // campus" (ver database.js) y este bloque no se ejecutaría. El
        // select de Ciudad no tendrá ninguna opción real para elegir, así
        // que el 'change' que dispara el resto de la cascada jamás
        // ocurriría — saltamos el paso y cargamos Tipo de Curso directo
        // (que también quedará vacío, ya que no hay datos).
        await loadCourseTypesForCollegeCity(id, college, "");

    }

}



/*==========================================================
 CASCADA: CIUDAD -> TIPO DE CURSO
==========================================================*/

async function loadCourseTypesForCollegeCity(id, college, city) {

    const types = await fetchCourseTypesByCollegeAndCity({ college, city });

    populateSelectOptions(`course_type_${id}`, types);

}

async function handleCityChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    const city = document.getElementById(`city_${id}`).value;

    await toggleStudentCityField(id, city);

    resetSelect(`course_type_${id}`);

    resetSelect(`program_${id}`);

    toggleWeeksField(id, "");

    if (!college || !city) return;

    await loadCourseTypesForCollegeCity(id, college, city);

}



/*==========================================================
 CASCADA: TIPO -> PROGRAMA
 Y VISIBILIDAD DE DURACIÓN (SOLO ELICOS)
 ----------------------------------------------------------
 Hasta la eliminación de "Subtipo" (decisión confirmada del
 cliente — ver database.js#fetchProgramsByCourseSelection), este
 paso pasaba por un nivel intermedio Subtipo antes de llegar a
 Programa. Ahora Programa se deriva directo de Colegio+Ciudad+Tipo.
==========================================================*/

async function handleCourseTypeChange(id) {

    const college = document.getElementById(`college_${id}`).value;

    const city = document.getElementById(`city_${id}`).value;

    const type = document.getElementById(`course_type_${id}`).value;

    toggleWeeksField(id, type);

    resetSelect(`program_${id}`);

    if (!type) return;

    const programs = await fetchProgramsByCourseSelection({ college, city, type });

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

            // Puede quedar como el texto literal "Todos los campus" cuando el
            // colegio tiene alguna fila de Cursos con Ciudad vacía (ver
            // fetchCitiesByCollege en database.js) -- eso sigue siendo un
            // valor "elegido" válido, no una ciudad vacía: fetchCourseDetails/
            // resolveCourseRow lo resuelven solos contra el comodín de Ciudad
            // vacía porque ninguna fila real puede calzar con ese texto.
            city: document.getElementById(`city_${id}`).value,

            // Solo tiene valor (y solo se exige) cuando city === "Todos los
            // campus" -- ver createStudentCityField/toggleStudentCityField
            // más arriba. Es la ciudad real que se muestra en PDF/resumen
            // (ver database.js#resolveCourseDisplayCity), nunca "city" en
            // ese caso.
            studentCity: document.getElementById(`student_city_${id}`).value,

            // false solo cuando el colegio no tiene NINGUNA fila cargada en
            // "Cursos" -- ahí el select de Ciudad nunca tiene una opción real
            // que elegir (ver handleCollegeChange), así que no tiene sentido
            // exigirla en collectWarnings/pricing.js.
            cityRequired: document.getElementById(`city_${id}`).options.length > 1,

            type: document.getElementById(`course_type_${id}`).value,

            program: document.getElementById(`program_${id}`).value,

            weeks: document.getElementById(`weeks_${id}`).value,

            // Obligatorio en todos los tipos de aplicación — ver
            // database.js#resolveWeeklyRate / evaluatePromotionsForCourse.
            schedule: document.getElementById(`schedule_${id}`).value,

            // Solo tiene efecto en Onshore — ver
            // pricing.js#applyInstitutionEnrollmentFeeRule.
            isExistingStudent: document.getElementById(`existing_student_${id}`).value === "Sí",

            // Modo Manual — ver createManualOverrideFields()/toggleManualOverride()
            // más arriba y pricing.js#calculateCourseLine (única prioridad: precio,
            // matrícula, materiales y semanas; todo lo demás sigue viniendo de la BD).
            isManualOverride: document.getElementById(`manualToggle_${id}`).classList.contains("active"),

            manualPrice: document.getElementById(`manual_price_${id}`).value,

            manualEnrollmentFee: document.getElementById(`manual_enrollment_${id}`).value,

            manualMaterialsFee: document.getElementById(`manual_materials_${id}`).value,

            manualWeeks: document.getElementById(`manual_weeks_${id}`).value

        });

    });

    return courses;

}
