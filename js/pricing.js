/*==========================================================
 LATINADVISOR
 PRICING MODULE
 VERSION 2.0 — MOTOR DE CÁLCULO SOBRE DATOS REALES DE SHEETS
 ----------------------------------------------------------
 Este módulo NO toca el DOM (salvo para leer, a través de los
 getters públicos de otros módulos: getStudentData(),
 getAllCoursesData(), getSelectedServices()) y NO habla con
 Google Sheets directamente — todo pasa por database.js.

 calculateQuotation() es la única función que app.js necesita
 llamar. El resto son piezas pequeñas, cada una con una sola
 responsabilidad, para que puedan probarse por separado.

 REGLAS DE NEGOCIO CONFIRMADAS (ver hoja real y decisiones del
 cliente):

   - El precio de un curso es Valor semana × Duración oficial
     (nunca la columna "Total" de la hoja, que es una caché
     manual que podría quedar desactualizada).
   - El descuento de un curso viene de la columna "Promoción"
     de la propia hoja "Cursos" cuando está presente (aunque
     sea 0); solo se consulta la hoja "Promociones" como
     respaldo si esa celda está vacía.
   - El seguro médico se busca por coincidencia EXACTA de
     semanas en la hoja "Seguros" — no se redondea ni se
     extrapola: la hoja debe tener una fila por cada duración
     real que se cotice.
   - La visa se cobra UNA sola vez por aplicante, con el tipo
     de curso de mayor jerarquía presente (HE > VET > ELICOS),
     no una vez por cada tipo de curso distinto.
==========================================================*/



/*==========================================================
 1. ORQUESTADOR PRINCIPAL
 ----------------------------------------------------------
 NIVEL 1 (compartido por todas las opciones de colegio):
 estudiante, moneda, recargo 2da aplicación, extras offshore,
 costos extras (exámenes) y servicios opcionales — todos
 dependen solo de input.student/input.services, nunca de qué
 cursos tenga cada pestaña, así que se calculan UNA sola vez.

 NIVEL 2 (una vez por pestaña/opción de colegio): cursos,
 seguro médico, visa, descuentos y totales — ver
 calculateOptionQuote(). Cada opción usa sus PROPIOS cursos
 pero reutiliza el NIVEL 1 ya resuelto (mismo servicio,
 mismas reglas, nunca se recalculan ni se mezclan entre
 opciones).
==========================================================*/

async function calculateQuotation() {

    const input = collectQuotationInput();

    const currency = await fetchCurrencyForDestination(input.student.destination);

    const secondApplicationSurcharge = await calculateSecondApplicationSurcharge({

        application_type: input.student.application_type,

        application_number: input.student.application_number,

        number_applicants: input.student.number_applicants

    });

    const offshoreExtras = await calculateOffshoreExtras({

        application_type: input.student.application_type,

        destination: input.student.destination

    });

    const extraCosts = await calculateExtraCosts({

        application_type: input.student.application_type,

        country: input.student.country

    });

    const servicesLines = await calculateServicesLines(input.services);

    const servicesSubtotal = sumBySubtotal(servicesLines);

    const shared = {

        student: input.student,

        secondApplicationSurcharge,

        offshoreExtras,

        servicesSubtotal

    };

    const options = await Promise.all(

        input.options.map(courseOption => calculateOptionQuote(courseOption, shared))

    );

    return {

        generatedAt: new Date().toISOString(),

        currency,

        student: input.student,

        services: servicesLines,

        secondApplicationSurcharge,

        offshoreExtras,

        extraCosts,

        options

    };

}



/*==========================================================
 1.1 CÁLCULO DE UNA OPCIÓN DE COLEGIO (PESTAÑA)
 ----------------------------------------------------------
 Toma los cursos de UNA pestaña + el contexto compartido
 (NIVEL 1, ya resuelto una sola vez en calculateQuotation) y
 produce el resultado completo de esa opción: cursos, seguro
 médico, visa (ambos recalculados con las semanas propias de
 ESTA opción), descuentos y totales. Nunca suma ni mezcla
 cursos de otra pestaña.
==========================================================*/

async function calculateOptionQuote(courseOption, shared) {

    const courseLines = await calculateAllCourseLines(courseOption.courses);

    const totalWeeks = computeTotalWeeks(courseLines);

    const insurance = await calculateInsurance({

        insuranceName: shared.student.insurance,

        totalWeeks,

        quotationType: shared.student.quotation_type

    });

    const visa = await calculateVisa({

        courseLines,

        destination: shared.student.destination,

        numberApplicants: shared.student.number_applicants

    });

    const promotionsApplied = collectPromotionsApplied(courseLines);

    const totals = assembleTotals({

        courseLines,

        insurance,

        visa,

        secondApplicationSurcharge: shared.secondApplicationSurcharge,

        offshoreExtras: shared.offshoreExtras,

        servicesSubtotal: shared.servicesSubtotal

    });

    const warnings = collectWarnings({

        courses: courseOption.courses,

        courseLines,

        insurance,

        visa,

        student: shared.student

    });

    return {

        id: courseOption.optionId,

        label: courseOption.optionLabel,

        courses: courseLines,

        insurance,

        visa,

        promotionsApplied,

        totals,

        warnings

    };

}



/*==========================================================
 1.2 ADAPTADOR "OPCIÓN -> COTIZACIÓN PLANA" (compatibilidad)
 ----------------------------------------------------------
 Reconstruye, para UNA opción puntual, exactamente el objeto
 "quote" plano que producía calculateQuotation() antes de
 soportar varias pestañas. Existe para que pdf.js
 (buildOverlayDocDefinition) y las funciones de persistencia en
 GHL (app.js) puedan seguir usándose SIN NINGÚN CAMBIO, una vez
 por opción — es la pieza que permite reutilizar toda la lógica
 ya existente dentro de cada alternativa de colegio.
==========================================================*/

function buildLegacyOptionQuote(quote, option) {

    return {

        generatedAt: quote.generatedAt,

        currency: quote.currency,

        student: quote.student,

        courses: option.courses,

        insurance: option.insurance,

        visa: option.visa,

        secondApplicationSurcharge: quote.secondApplicationSurcharge,

        offshoreExtras: quote.offshoreExtras,

        extraCosts: quote.extraCosts,

        services: quote.services,

        promotionsApplied: option.promotionsApplied,

        totals: option.totals,

        warnings: option.warnings

    };

}



/*==========================================================
 2. RECOLECCIÓN DE INPUT
 ----------------------------------------------------------
 No calcula nada. Solo reúne lo que otros módulos ya
 capturaron en el DOM. "options" trae una entrada por pestaña
 de opción de colegio, cada una con sus propios cursos (ver
 js/course-options.js#getAllCourseOptionsData).
==========================================================*/

function collectQuotationInput() {

    return {

        student: getStudentData(),

        options: getAllCourseOptionsData(),

        services: typeof getSelectedServices === "function" ? getSelectedServices() : []

    };

}



/*==========================================================
 3. CÁLCULO POR CURSO
 ----------------------------------------------------------
 El precio y el descuento se resuelven en database.js
 (fetchCourseDetails); aquí solo se ensambla el subtotal neto.

 La duración ("officialWeeks") ya viene resuelta según el tipo:
 para ELICOS es la que ingresó la asesora, para VET/HE es la de
 la hoja "Cursos" (ver database.js#fetchCourseDetails).
==========================================================*/

async function calculateCourseLine(course) {

    const requestedWeeks = Number(course.weeks) || 0;

    const details = await fetchCourseDetails({

        college: course.college,

        city: course.city,

        type: course.type,

        subtype: course.subtype,

        program: course.program,

        weeks: course.weeks

    });

    const grossSubtotal = details.price + details.enrollmentFee + details.materialsFee;

    return {

        id: course.id,

        college: course.college,

        city: course.city,

        type: course.type,

        subtype: course.subtype,

        program: course.program,

        requestedWeeks,

        officialWeeks: details.officialWeeks,

        found: details.found,

        price: details.price,

        enrollmentFee: details.enrollmentFee,

        materialsFee: details.materialsFee,

        discount: details.discount,

        discountSource: details.discountSource,

        subtotal: grossSubtotal - details.discount

    };

}

async function calculateAllCourseLines(courses) {

    return Promise.all(courses.map(calculateCourseLine));

}



/*==========================================================
 4. SEGURO MÉDICO
 ----------------------------------------------------------
 Costo = valor semanal del plan elegido × duración total de la
 cotización (suma de las semanas de todos los cursos, cada una
 ya resuelta según su tipo — ver calculateCourseLine).
==========================================================*/

function computeTotalWeeks(courseLines) {

    return courseLines.reduce((sum, line) => sum + (line.officialWeeks || line.requestedWeeks || 0), 0);

}

async function calculateInsurance({ insuranceName, totalWeeks, quotationType }) {

    if (!insuranceName) {

        return { name: "", totalWeeks, quotationType, weeklyRate: 0, cost: 0, found: false };

    }

    const rate = await fetchInsuranceWeeklyRate({ insuranceName, quotationType });

    return {

        name: insuranceName,

        totalWeeks,

        quotationType,

        weeklyRate: rate.weeklyRate,

        cost: rate.weeklyRate * totalWeeks,

        found: rate.found

    };

}



/*==========================================================
 5. VISA
==========================================================*/

async function calculateVisa({ courseLines, destination, numberApplicants }) {

    const courseTypes = [...new Set(courseLines.map(line => line.type).filter(Boolean))];

    const result = await fetchVisaCost({ destination, courseTypes, numberApplicants });

    return {

        courseTypes,

        primaryType: result.primaryType,

        numberApplicants,

        cost: result.total,

        found: result.found

    };

}



/*==========================================================
 6. SEGUNDA APLICACIÓN (ONSHORE)
 ----------------------------------------------------------
 Aplica solo si Onshore y número de aplicación > 1.
 El monto es POR APLICANTE (regla confirmada por el cliente).
==========================================================*/

async function calculateSecondApplicationSurcharge({ application_type, application_number, number_applicants }) {

    const applies = application_type === "Onshore" && application_number > 1;

    if (!applies) {

        return {

            applies: false,

            perApplicantAmount: 0,

            numberApplicants: number_applicants,

            totalAmount: 0

        };

    }

    const perApplicantAmount = await fetchSecondApplicationSurcharge();

    return {

        applies: true,

        perApplicantAmount,

        numberApplicants: number_applicants,

        totalAmount: perApplicantAmount * number_applicants

    };

}



/*==========================================================
 7. EXTRAS OFFSHORE
 ----------------------------------------------------------
 Se suman TODAS las filas de "Costos Fijos" que apliquen al
 destino (sin códigos fijos por concepto): un concepto nuevo
 en la hoja se incluye automáticamente.
==========================================================*/

/*
    La hoja "Costos Fijos" trae, por herencia, filas para
    "Exámenes Biométricos"/"Exámenes Médicos" (código slugificado:
    ver database.js#fetchOffshoreExtraCosts). Esos dos conceptos
    ahora se gobiernan EXCLUSIVAMENTE por calculateExtraCosts
    (sección 7.1: Offshore + país autorizado, valor desde
    "Parámetros") y nunca deben sumarse al total — se excluyen
    aquí para no duplicarlos ni sumarlos por error.
*/

const OFFSHORE_EXTRAS_EXCLUDED_CODES = ["examenes-biometricos", "examenes-medicos"];

async function calculateOffshoreExtras({ application_type, destination }) {

    const applies = application_type === "Offshore";

    if (!applies) {

        return { applies: false, items: [], total: 0 };

    }

    const rawItems = await fetchOffshoreExtraCosts(destination);

    const items = rawItems.filter(item => !OFFSHORE_EXTRAS_EXCLUDED_CODES.includes(item.code));

    return {

        applies: true,

        items,

        total: items.reduce((sum, item) => sum + item.amount, 0)

    };

}



/*==========================================================
 7.1 COSTOS EXTRAS (EXÁMENES MÉDICOS Y BIOMÉTRICOS)
 ----------------------------------------------------------
 Regla de negocio confirmada por el cliente: Exámenes Médicos y
 Exámenes Biométricos SOLO se muestran cuando la cotización es
 Offshore Y el país del estudiante (que llega desde GoHighLevel,
 ver student.js#getStudentCountryFromGhl) está en la lista de
 países autorizados. En cualquier otro escenario (Onshore, o
 país no autorizado) no aparecen.

 IMPORTANTE: estos valores son informativos ("Costos Extras",
 se pagan directamente a cada entidad proveedora) y NUNCA deben
 sumarse al total principal — por eso NO se pasan a
 assembleTotals() y viajan aparte en quote.extraCosts.
==========================================================*/

const MEDICAL_EXAM_ELIGIBLE_COUNTRIES = ["colombia", "mexico", "peru", "argentina", "chile", "espana"];

function isCountryEligibleForMedicalExams(country) {

    const normalized = stripAccents(normalize(country));

    return MEDICAL_EXAM_ELIGIBLE_COUNTRIES.includes(normalized);

}

async function calculateExtraCosts({ application_type, country }) {

    const applies = application_type === "Offshore" && isCountryEligibleForMedicalExams(country);

    if (!applies) {

        return { applies: false, country, items: [], total: 0 };

    }

    const [biometricCost, medicalCost] = await Promise.all([

        fetchBiometricExamCost(),

        fetchMedicalExamCost()

    ]);

    const items = [

        { code: "examen-biometrico", label: "Exámenes Biométricos", amount: biometricCost },

        { code: "examen-medico", label: "Exámenes Médicos", amount: medicalCost }

    ];

    return {

        applies: true,

        country,

        items,

        total: items.reduce((sum, item) => sum + item.amount, 0)

    };

}



/*==========================================================
 8. SERVICIOS OPCIONALES
==========================================================*/

async function calculateServicesLines(selectedServices) {

    if (!selectedServices || selectedServices.length === 0) return [];

    const catalog = await fetchServiceCatalog();

    return selectedServices.map(selected => {

        const catalogEntry = catalog.find(entry => entry.code === selected.serviceCode);

        const unitCost = catalogEntry ? catalogEntry.unitCost : 0;

        const label = catalogEntry ? catalogEntry.label : selected.serviceCode;

        const quantity = selected.quantity || 1;

        return {

            serviceCode: selected.serviceCode,

            label,

            quantity,

            unitCost,

            subtotal: unitCost * quantity

        };

    });

}



/*==========================================================
 9. PROMOCIONES APLICADAS
 ----------------------------------------------------------
 El descuento por curso ya se resolvió en database.js
 (fetchCourseDetails -> resolveCourseDiscount). Aquí solo se
 recopila la lista de promociones efectivamente aplicadas,
 para mostrarlas en el resumen.
==========================================================*/

function collectPromotionsApplied(courseLines) {

    return courseLines

        .filter(line => line.discount > 0)

        .map(line => ({

            courseId: line.id,

            description: line.discountSource || "Promoción",

            amountDiscounted: line.discount

        }));

}



/*==========================================================
 10. ENSAMBLADO DE TOTALES
 ----------------------------------------------------------
 Exactamente 4 conceptos + el total, cada uno con una única
 responsabilidad, ninguno se vuelve a sumar en otro lado:

   subtotalCursos  = suma de los cursos EN BRUTO (sin descuento)
   otrosCargos     = seguro médico + visa
   adicionales     = recargo 2da aplicación + extras offshore + servicios
   descuento       = suma de los descuentos por curso
   total           = subtotalCursos + otrosCargos + adicionales - descuento

 Esta es la ÚNICA fórmula que produce "total" en todo el
 sistema — no existe un segundo cálculo paralelo en otro lado
 (por eso las secciones de detalle en summary.js son solo
 informativas: siempre pueden reconstruirse a partir de estos
 4 números y nunca deben sumarse dos veces).

 quote.extraCosts (exámenes médicos/biométricos, ver sección
 7.1) es DELIBERADAMENTE ajeno a esta fórmula: son Costos
 Extras informativos que nunca deben sumarse al total.
==========================================================*/

function sumBySubtotal(lines) {

    return lines.reduce((sum, line) => sum + line.subtotal, 0);

}

function assembleTotals({ courseLines, insurance, visa, secondApplicationSurcharge, offshoreExtras, servicesSubtotal }) {

    const subtotalCursos = courseLines.reduce((sum, line) => sum + line.price + line.enrollmentFee + line.materialsFee, 0);

    const descuento = courseLines.reduce((sum, line) => sum + line.discount, 0);

    const otrosCargos = insurance.cost + visa.cost;

    const adicionales = secondApplicationSurcharge.totalAmount + offshoreExtras.total + servicesSubtotal;

    const total = subtotalCursos + otrosCargos + adicionales - descuento;

    return {

        subtotalCursos,

        otrosCargos,

        adicionales,

        descuento,

        total

    };

}



/*==========================================================
 11. VALIDACIÓN / ADVERTENCIAS
 ----------------------------------------------------------
 Nunca lanza excepciones: un curso incompleto, o sin datos en
 Sheets, se reporta como advertencia, no rompe el cálculo de
 toda la cotización.
==========================================================*/

function collectWarnings({ courses, courseLines, insurance, visa, student }) {

    const warnings = [];

    courses.forEach((course, index) => {

        const missingFields = [];

        if (!course.college) missingFields.push("Colegio");

        if (!course.city) missingFields.push("Ciudad");

        if (!course.type) missingFields.push("Tipo de Curso");

        if (!course.subtype) missingFields.push("Subtipo");

        if (!course.program) missingFields.push("Programa");

        if (course.type === "ELICOS" && (!course.weeks || Number(course.weeks) <= 0)) {

            missingFields.push("Duración (semanas)");

        }

        if (missingFields.length > 0) {

            warnings.push(`Curso #${index + 1}: falta diligenciar ${missingFields.join(", ")}.`);

        }

    });

    courseLines.forEach((line, index) => {

        if (!line.found && line.college && line.program) {

            warnings.push(

                `Curso #${index + 1}: no se encontró esa combinación exacta en la hoja "Cursos". ` +

                `Verifica Colegio/Ciudad/Tipo/Subtipo/Programa.`

            );

        }

    });

    if (!student.insurance) {

        warnings.push("No se ha seleccionado un seguro médico.");

    } else if (!insurance.found) {

        warnings.push(

            `Seguro médico: no se encontró una tarifa para "${student.insurance}" con tipo de cotización ` +

            `"${student.quotation_type}" en la hoja "Seguros".`

        );

    }

    if (!visa.found && visa.primaryType) {

        warnings.push(

            `Visa: no se encontró tarifa para destino "${student.destination}" y tipo "${visa.primaryType}" en la hoja "Visas".`

        );

    }

    if (!student.email) {

        warnings.push("El estudiante no tiene correo electrónico registrado.");

    }

    return warnings;

}
