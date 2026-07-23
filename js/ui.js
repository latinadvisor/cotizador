/*==========================================================
 LATINADVISOR UI FRAMEWORK
 VERSION 1.0
==========================================================*/


/*==========================================
HEADER
==========================================*/

function createHeader(){

    return `

    <header class="header">

        <h1>LatinAdvisor</h1>

        <p>Academic Quotation System</p>

    </header>

    `;

}


/*==========================================
UTILIDADES COMPARTIDAS
------------------------------------------
weeksToMonthsLabel() se usa tanto en el
resumen en pantalla (summary.js) como en el
PDF (pdf.js) — vive acá para no duplicarla.
==========================================*/

function weeksToMonthsLabel(weeks) {

    const totalWeeks = Number(weeks) || 0;

    if (totalWeeks <= 0) return "-";

    const months = Math.round(totalWeeks / 4.345);

    return `${totalWeeks} semanas (${months} ${months === 1 ? "mes" : "meses"})`;

}



/*==========================================
CARD
==========================================*/

function createCard(title,content,options={}){

    const {id="",collapsible=false}=options;

    const idAttribute=id?` id="${id}"`:"";

    const header=collapsible

        ?`

            <div class="card-header-toggle" onclick="toggleCardCollapse('${id}')">

                <h2>${title}</h2>

                <span class="card-toggle-icon">▾</span>

            </div>

        `

        :`<h2>${title}</h2>`;

    return `

    <section class="card"${idAttribute}>

        ${header}

        <div class="card-body">

            ${content}

        </div>

    </section>

    `;

}



/*==========================================
COLAPSO DE TARJETAS (ACORDEÓN)
==========================================*/

function toggleCardCollapse(id){

    const card=document.getElementById(id);

    if(!card) return;

    card.classList.toggle("card-collapsed");

}

function setCardCollapsed(id,collapsed){

    const card=document.getElementById(id);

    if(!card) return;

    card.classList.toggle("card-collapsed",collapsed);

}


/*==========================================
SECTION TITLE
==========================================*/

function createSectionTitle(title){

    return `

        <div class="section-title">

            ${title}

        </div>

    `;

}



/*==========================================
INPUT
==========================================*/

function createInput({

    label,

    id,

    type="text",

    placeholder="",

    min="",

    step=""

}){

    return `

    <div class="form-group">

        <label for="${id}">

            ${label}

        </label>

        <input

            id="${id}"

            type="${type}"

            placeholder="${placeholder}"

            min="${min}"

            step="${step}"

        >

    </div>

    `;

}



/*==========================================
SELECT
==========================================*/

function createSelect({

    label,

    id,

    options=[]

}){

    let optionsHTML="";

    options.forEach(option=>{

        optionsHTML+=`

            <option value="${option}">

                ${option}

            </option>

        `;

    });

    return `

    <div class="form-group">

        <label for="${id}">

            ${label}

        </label>

        <select id="${id}">

            ${optionsHTML}

        </select>

    </div>

    `;

}



/*==========================================
MODAL DE CONFIRMACIÓN
------------------------------------------
Un único nodo modal reutilizado por toda la
app (eliminar curso, eliminar opción de
cotización, etc.). Cerrar por backdrop, Escape
o "Cancelar" NUNCA ejecuta onConfirm.
==========================================*/

let confirmModalOnConfirm = null;

function ensureConfirmModalNode() {

    let modal = document.getElementById("confirmModal");

    if (modal) return modal;

    document.body.insertAdjacentHTML("beforeend", `

        <div id="confirmModal" class="modal-overlay hidden">

            <div class="modal-box">

                <p id="confirmModalMessage" class="modal-message"></p>

                <div class="modal-actions">

                    <button type="button" id="confirmModalCancel" class="btn btn-secondary"></button>

                    <button type="button" id="confirmModalConfirm" class="btn btn-danger"></button>

                </div>

            </div>

        </div>

    `);

    modal = document.getElementById("confirmModal");

    modal.addEventListener("click", event => {

        if (event.target === modal) closeConfirmModal();

    });

    document.getElementById("confirmModalCancel").addEventListener("click", closeConfirmModal);

    document.getElementById("confirmModalConfirm").addEventListener("click", () => {

        const onConfirm = confirmModalOnConfirm;

        closeConfirmModal();

        if (typeof onConfirm === "function") onConfirm();

    });

    document.addEventListener("keydown", event => {

        if (event.key === "Escape" && !modal.classList.contains("hidden")) closeConfirmModal();

    });

    return modal;

}

function closeConfirmModal() {

    const modal = document.getElementById("confirmModal");

    if (modal) modal.classList.add("hidden");

    confirmModalOnConfirm = null;

}

function showConfirmModal({ message, confirmLabel = "Confirmar", cancelLabel = "Cancelar", onConfirm }) {

    const modal = ensureConfirmModalNode();

    document.getElementById("confirmModalMessage").textContent = message;

    document.getElementById("confirmModalCancel").textContent = cancelLabel;

    document.getElementById("confirmModalConfirm").textContent = confirmLabel;

    confirmModalOnConfirm = onConfirm;

    modal.classList.remove("hidden");

}



/*==========================================
BUTTON
==========================================*/

function createButton(text,id,options={}){

    const {disabled=false,variant=""}=options;

    const disabledAttribute=disabled?" disabled":"";

    const variantClass=variant?` btn-${variant}`:"";

    return `

    <button
        id="${id}"
        class="btn${variantClass}"
        ${disabledAttribute}>

        ${text}

    </button>

    `;

}