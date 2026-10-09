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
   - El descuento de un curso viene de las columnas "Indicador de
     descuento"/"valor descuento" de la propia fila de "Cursos"
     (ver database.js#buildCourseDiscountEffect) — ya no existe una
     hoja "Promociones" separada.
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

    const extraCosts = await calculateExtraCosts();

    // Ver resolveBestAirportPickupRate más abajo — Airport Pickup sigue
    // siendo NIVEL 1 (compartido entre todas las opciones de colegio,
    // igual que SIM Card/Traducciones), pero su precio depende de la
    // ciudad de estudio, así que hay que resolverlo ANTES de armar
    // servicesLines, mirando los cursos de TODAS las opciones (decisión
    // confirmada del cliente, 2026-10-07).
    const airportPickupRate = await resolveBestAirportPickupRate(input.options);

    const servicesLines = await calculateServicesLines(input.services, airportPickupRate);

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

    /*
        El país de búsqueda NO es shared.student.country (residencia,
        viene de GHL) sino el país derivado del gentilicio elegido en el
        formulario (shared.student.nationality) — ver
        countries.js#resolveNationalitySearchCountry. Residencia y
        nacionalidad pueden diferir (ej. reside en Colombia, nacionalidad
        española); solo cae a residencia cuando el gentilicio es "Otra".
    */
    const nationalitySearchCountry = resolveNationalitySearchCountry(shared.student.nationality, shared.student.country);

    const courseLines = await calculateAllCourseLines(courseOption.courses, nationalitySearchCountry, shared.student.application_type);

    applyInstitutionEnrollmentFeeRule(courseLines, shared.student.application_type);

    await applyOnshoreFirstPaymentDeposits(courseLines, shared.student.application_type);

    const totalWeeks = computeTotalWeeks(courseLines);

    const insurance = await calculateInsurance({

        insuranceName: shared.student.insurance,

        totalWeeks,

        quotationType: shared.student.quotation_type

    });

    const visa = await calculateVisa({

        courseLines,

        destination: shared.student.destination,

        quotationType: shared.student.quotation_type,

        numberOfMinors: shared.student.number_of_minors

    });

    // "Seguro Gratis"/"Visa Gratis" (ver database.js#buildCourseDiscountEffect):
    // basta con que UN curso de la opción lo traiga para que ese costo
    // quede en $0 para TODA la opción — Seguro/Visa son costos únicos por
    // opción, no por curso, así que no tiene sentido "ser gratis a medias".
    if (courseLines.some(line => line.waiveInsurance)) insurance.cost = 0;

    if (courseLines.some(line => line.waiveVisa)) {

        visa.cost = 0;

        visa.singleAmount = 0;

        visa.coupleAmount = 0;

        visa.minorAmount = 0;

    }

    const promotionsApplied = collectPromotionsApplied(courseLines);

    const totals = assembleTotals({

        courseLines,

        insurance,

        visa,

        secondApplicationSurcharge: shared.secondApplicationSurcharge,

        offshoreExtras: shared.offshoreExtras,

        servicesSubtotal: shared.servicesSubtotal,

        applicationType: shared.student.application_type,

        totalWeeks

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

/*
    Modo Manual (ver courses.js#createManualOverrideFields/toggleManualOverride):
    la asesora puede sobrescribir precio, matrícula, materiales y duración de un
    curso puntual para negociaciones especiales, promociones no registradas, o
    programas que aún no existen en la base de datos. Un campo vacío o no
    numérico simplemente no sobrescribe nada (cae al valor de catálogo).
*/

function parseManualOverrideValue(rawValue) {

    if (rawValue === undefined || rawValue === null || rawValue === "") return null;

    const parsed = Number(rawValue);

    return Number.isNaN(parsed) ? null : parsed;

}

async function calculateCourseLine(course, country, applicationType) {

    const requestedWeeks = Number(course.weeks) || 0;

    const details = await fetchCourseDetails({

        college: course.college,

        city: course.city,

        type: course.type,

        program: course.program,

        weeks: course.weeks,

        schedule: course.schedule,

        country,

        applicationType

    });

    const isManualOverride = !!course.isManualOverride;

    const manualPrice = parseManualOverrideValue(course.manualPrice);

    const manualEnrollmentFee = parseManualOverrideValue(course.manualEnrollmentFee);

    const manualMaterialsFee = parseManualOverrideValue(course.manualMaterialsFee);

    const manualWeeks = parseManualOverrideValue(course.manualWeeks);

    const price = (isManualOverride && manualPrice !== null) ? manualPrice : details.price;

    const enrollmentFee = (isManualOverride && manualEnrollmentFee !== null) ? manualEnrollmentFee : details.enrollmentFee;

    const materialsFee = (isManualOverride && manualMaterialsFee !== null) ? manualMaterialsFee : details.materialsFee;

    const officialWeeks = (isManualOverride && manualWeeks !== null) ? manualWeeks : details.officialWeeks;

    const grossSubtotal = price + enrollmentFee + materialsFee;

    return {

        id: course.id,

        college: course.college,

        city: course.city,

        // Ciudad real del estudiante cuando city === "Todos los campus" —
        // ver database.js#resolveCourseDisplayCity, usado por summary.js/
        // pdf.js/app.js para mostrar la ciudad en vez del texto interno.
        studentCity: course.studentCity,

        type: course.type,

        program: course.program,

        schedule: course.schedule,

        requestedWeeks,

        officialWeeks,

        found: details.found,

        // Ver database.js#fetchCourseDetails y pricing.js#collectWarnings
        // más abajo — si la asesora ya puso un precio manual (modo
        // Manual), ese precio manda y no importa que falte tarifa de
        // catálogo, así que el aviso se omite en ese caso.
        weeklyRateMissing: !!details.weeklyRateMissing && !(isManualOverride && manualPrice !== null),

        price,

        enrollmentFee,

        materialsFee,

        discount: details.discount,

        discountSource: details.discountSource,

        discountMergeLabel: !!details.discountMergeLabel,

        // Bonos informativos (ej. SEMANAS_GRATIS) — nunca afectan
        // subtotal/total, ver database.js#fetchCourseDetails.
        bonusNotes: details.bonusNotes || [],

        // Desglose de "discount" en sus 2 componentes — solo los usa
        // pricing.js#calculateOffshoreFirstPayment25Plus, ver esa función.
        priceDiscount: details.priceDiscount || 0,

        enrollmentFeeWaivedAmount: details.enrollmentFeeWaivedAmount || 0,

        materialsFeeWaivedAmount: details.materialsFeeWaivedAmount || 0,

        subtotal: grossSubtotal - details.discount,

        // Tarifa semanal Onshore de catálogo — insumo de
        // applyOnshoreFirstPaymentDeposits() más abajo. El depósito en sí
        // (firstPaymentDeposit) NO se calcula aquí: depende de la
        // Matrícula/Materiales ya netos de applyInstitutionEnrollmentFeeRule,
        // que corre DESPUÉS de esta función — ver calculateOptionQuote.
        onshoreWeeklyRate: details.onshoreWeeklyRate || 0,

        firstPaymentDeposit: 0,

        firstPaymentDepositMissing: false,

        // "condición extra" = "Nota" en Primer depósito Onshore (ver
        // database.js#fetchOnshoreDepositCondition) — texto libre que
        // pdf.js#collectNotes agrega a las Notas del PDF cuando aplica.
        firstPaymentDepositNote: "",

        // Indicadores "Seguro Gratis"/"Visa Gratis" (ver
        // database.js#buildCourseDiscountEffect) — Seguro/Visa se calculan
        // UNA vez por opción, no por curso, así que esto solo viaja hasta
        // calculateOptionQuote, que pone el costo en $0 si CUALQUIER curso
        // de la opción trae la bandera en true.
        waiveInsurance: !!details.waiveInsurance,

        waiveVisa: !!details.waiveVisa,

        // "¿Es estudiante de la institución?" (solo se pregunta/usa en
        // Onshore) — ver pricing.js#applyInstitutionEnrollmentFeeRule.
        isExistingStudent: !!course.isExistingStudent,

        // Informativo — permite que PDF/resumen señalen que este curso
        // tiene valores editados manualmente, si se desea en el futuro.
        isManualOverride,

        // Fecha de inicio del curso (ver courses.js#createStartDateField) —
        // igual que isManualOverride, puramente informativo por ahora.
        startDate: course.startDate || ""

    };

}

async function calculateAllCourseLines(courses, country, applicationType) {

    return Promise.all(courses.map(course => calculateCourseLine(course, country, applicationType)));

}

/*==========================================================
 3.1 REGLA DE MATRÍCULA POR INSTITUCIÓN (no por curso)
 ----------------------------------------------------------
 La matrícula se cobra UNA SOLA VEZ por colegio DENTRO DE CADA
 OPCIÓN, sin importar cuántos cursos tenga esa opción en ese
 colegio (pedido explícito del cliente). Si la cotización es
 Onshore y la asesora marca "¿Es estudiante de la institución?"
 = Sí en el PRIMER curso de ese colegio, la matrícula de ese
 colegio queda en $0 — el estudiante ya pertenece a la
 institución. Offshore nunca usa isExistingStudent (la pregunta
 ni siquiera se muestra ahí, ver courses.js).

 Se SOBREESCRIBEN enrollmentFee/subtotal en el mismo courseLine,
 en vez de calcular esto aparte, para que todo lo que YA lee
 esos dos campos (assembleTotals más abajo, el desglose del PDF,
 la sincronización de líneas de curso con GHL en app.js) use
 automáticamente el valor correcto sin tener que tocar cada uno
 de esos lugares — única fuente de verdad, como pidió el
 cliente. enrollmentFeeOriginal/enrollmentFeeNote quedan
 disponibles solo para que el PDF pueda explicar el porqué del
 $0 en cada línea (ver pdf.js#buildCostTableSection).
==========================================================*/

function applyInstitutionEnrollmentFeeRule(courseLines, applicationType) {

    const seenColleges = new Set();

    courseLines.forEach(line => {

        const college = line.college || "";

        const isFirstForCollege = !seenColleges.has(college);

        seenColleges.add(college);

        const originalEnrollmentFee = line.enrollmentFee;

        const isWaivedByThisCourse = applicationType === "Onshore" && line.isExistingStudent;

        /*
            El MONTO cobrado depende solo de "¿es el primer curso de este
            colegio en la opción?" (nunca se cobra dos veces la matrícula
            de un mismo colegio). La ETIQUETA/motivo, en cambio, refleja
            la respuesta de ESTE curso en particular — así, si dos cursos
            del mismo colegio responden ambos "Sí", los DOS muestran "ya
            es estudiante de la institución" en vez de que el segundo
            diga "incluida con otro curso" (pedido explícito del cliente).
        */

        const chargedEnrollmentFee = (isFirstForCollege && !isWaivedByThisCourse) ? originalEnrollmentFee : 0;

        const note = isWaivedByThisCourse ? "waived" : (isFirstForCollege ? "charged" : "included");

        line.enrollmentFeeOriginal = originalEnrollmentFee;

        line.enrollmentFee = chargedEnrollmentFee;

        line.enrollmentFeeNote = note;

        line.subtotal = line.price + chargedEnrollmentFee + line.materialsFee - line.discount;

    });

    return courseLines;

}

/*==========================================================
 3.2 PRIMER DEPÓSITO ONSHORE (por curso, parametrizado por Colegio)
 ----------------------------------------------------------
 Reemplaza a la antigua columna "Primer deposito" de "Cursos". La
 condición de cada Colegio vive en la pestaña "Primer depósito
 Onshore" (ver database.js#fetchOnshoreDepositCondition/
 computeOnshoreDeposit) — aquí solo se orquesta CUÁNDO se calcula:
 DESPUÉS de applyInstitutionEnrollmentFeeRule(), para que
 line.enrollmentFee/line.materialsFee ya sean los valores
 definitivos (netos de matrícula única por colegio y de cualquier
 promoción de matrícula/materiales gratis) — exactamente los que
 pide sumar la fórmula.

 Fórmula (decisión confirmada del cliente — 4 tipos de condición,
 ver database.js#ONSHORE_DEPOSIT_CONDITION_TYPES):
   "Valor fijo"                                   -> Depósito = Parámetro (solo eso, sin fees)
   "Valor + Matricula + Materiales"                -> Depósito = Parámetro + Matrícula + Materiales
   "Semanas de estudio + Matricula + Materiales"   -> Depósito = (tarifa semanal Onshore cotizada × Parámetro) + Matrícula + Materiales
   "Tiempo + Matricula + Materiales" (2026-10-09,
   ej. Impact College, varios tramos por Duración
   vía "condición extra")                          -> Depósito = (Parámetro% × Curso neto de descuento) + Matrícula + Materiales

 Si el Colegio no tiene fila en esa pestaña, O la tiene pero con un
 "Tipo de condición" vacío/no reconocido, el depósito de ese curso
 queda en 0 y se marca firstPaymentDepositMissing=true, para que
 collectWarnings() avise a la asesora ANTES de generar la
 cotización — no hay respaldo silencioso a ningún valor viejo ni a
 un depósito incompleto (decisión confirmada del cliente).

 "condición extra" = "Nota" (decisión confirmada del cliente,
 2026-10-10, ej. Greenwich College): no cambia la fórmula del
 depósito (sigue el "Tipo de condición" normal de esa fila) — solo
 agrega el texto libre de la columna "información de la nota" a
 line.firstPaymentDepositNote, que pdf.js#collectNotes suma a las
 Notas del PDF (deduplicado si varios cursos comparten colegio).

 No hace nada para Offshore — ahí el Primer Pago sigue la fórmula
 de calculateOffshoreFirstPayment25Plus(), sin relación con esto.
==========================================================*/

async function applyOnshoreFirstPaymentDeposits(courseLines, applicationType) {

    if (applicationType !== "Onshore") return;

    for (const line of courseLines) {

        // officialWeeks: necesario para colegios con varios tramos de
        // "condición extra" (ej. Impact College) — ver
        // database.js#fetchOnshoreDepositCondition.
        const condition = await fetchOnshoreDepositCondition(line.college, line.officialWeeks);

        // Sin fila, con "Tipo de condición" vacío/no reconocido, o
        // ningún tramo de "condición extra" que cubra la Duración real
        // del curso (ver database.js#fetchOnshoreDepositCondition) —
        // todos los casos avisan y bloquean, en vez de mostrar un
        // depósito de $0 en silencio (decisión confirmada del cliente).
        if (!condition.found || !condition.recognized) {

            line.firstPaymentDeposit = 0;

            line.firstPaymentDepositMissing = true;

            continue;

        }

        line.firstPaymentDeposit = computeOnshoreDeposit(condition, {

            onshoreWeeklyRate: line.onshoreWeeklyRate,

            price: line.price,

            priceDiscount: line.priceDiscount,

            enrollmentFee: line.enrollmentFee,

            materialsFee: line.materialsFee

        });

        line.firstPaymentDepositNote = condition.infoNote || "";

    }

}



/*==========================================================
 4. SEGURO MÉDICO (decisión confirmada del cliente, 2026-10-07)
 ----------------------------------------------------------
 Ya NO se calcula (valor semanal × semanas): igual que los cursos,
 la hoja "Seguros" trae el monto TOTAL ya resuelto por (plan,
 duración exacta) — se lee directo, sin aritmética, ver
 database.js#fetchInsuranceCost. "totalWeeks" aquí es la duración
 real de la cotización (suma de las semanas de todos los cursos,
 ver computeTotalWeeks) — ya NO se le suma ningún offset de
 "semanas de vacaciones": eso ahora vive baked-in en el monto de
 cada fila de la hoja (columna "vacaciones", solo informativa para
 quien la carga). insurance.cost es la ÚNICA fuente de este monto
 — pantalla (summary.js), Resumen Financiero (assembleTotals) y PDF
 (pdf.js) lo leen tal cual.

 Si no existe una fila para (plan, totalWeeks) exactos, se trata
 como "no encontrado" (found:false) — collectWarnings() avisa y
 bloquea "Generar Cotización", igual que cualquier otro dato
 faltante. Qué hacer cuando la duración no calza exacto (¿tomar la
 más cercana? ¿cuál redondeo?) queda PENDIENTE de definir con el
 cliente — por ahora es estrictamente "exacto o nada".
==========================================================*/

function computeTotalWeeks(courseLines) {

    return courseLines.reduce((sum, line) => sum + (line.officialWeeks || line.requestedWeeks || 0), 0);

}

async function calculateInsurance({ insuranceName, totalWeeks, quotationType }) {

    if (!insuranceName) {

        return { name: "", totalWeeks, quotationType, cost: 0, found: false };

    }

    const rate = await fetchInsuranceCost({ insuranceName, quotationType, totalWeeks });

    return {

        name: insuranceName,

        totalWeeks,

        quotationType,

        cost: rate.amount,

        found: rate.found

    };

}



/*==========================================================
 5. VISA
 ----------------------------------------------------------
 VISA_CREDIT_CARD_SURCHARGE_RATE (decisión confirmada del cliente,
 2026-10-07): la pasarela de pago SIEMPRE cobra 1.4% extra sobre
 cualquier cargo de Visa — se suma aquí, a la salida de
 fetchVisaCost(), para que TODO lo que ya lee visa.cost (Otros
 Cargos, Primer Pago Onshore, fórmula Offshore ≥25 semanas) lo
 reciba automáticamente incluido, sin tener que tocar cada sitio
 donde se usa. El recargo de 3ra aplicación (más abajo) es visa
 también, así que lleva el mismo 1.4% — aplicado por separado en su
 propio cálculo, nunca sumado dos veces. Es una constante de código
 (no vive en la hoja "Parámetros") porque el cliente dio un número
 fijo — si más adelante necesita ajustarse sin tocar código, mover
 a Parámetros.
==========================================================*/

const VISA_CREDIT_CARD_SURCHARGE_RATE = 0.014;

async function calculateVisa({ courseLines, destination, quotationType, numberOfMinors }) {

    const courseTypes = [...new Set(courseLines.map(line => line.type).filter(Boolean))];

    const result = await fetchVisaCost({ destination, courseTypes, quotationType, numberOfMinors });

    // El 1.4% se aplica a CADA componente por separado (no al total final)
    // — algebraicamente da lo mismo (ver VISA_CREDIT_CARD_SURCHARGE_RATE),
    // pero así el PDF puede mostrar cada línea (persona/pareja/menor) YA
    // con el recargo incluido, sin tener que repartirlo después.
    const singleAmount = result.singleRate * (1 + VISA_CREDIT_CARD_SURCHARGE_RATE);

    const coupleAmount = result.coupleRate * (1 + VISA_CREDIT_CARD_SURCHARGE_RATE);

    const minorAmount = result.minorRate * result.numberOfMinors * (1 + VISA_CREDIT_CARD_SURCHARGE_RATE);

    const type = normalize(quotationType);

    const includesCouple = type === normalize("Couple") || type === normalize("Family");

    const includesMinors = type === normalize("Family");

    return {

        courseTypes,

        primaryType: result.primaryType,

        quotationType,

        numberOfMinors: result.numberOfMinors,

        // Desglose para pdf.js#buildCostTableSection — cada uno YA trae el
        // 1.4% incluido. "coupleAmount"/"minorAmount" quedan en 0 cuando no
        // aplican (Single, o Family sin menores), para que una línea $0 no
        // aparezca en el PDF (ver el "if" de cada fila ahí).
        singleAmount,

        coupleAmount: includesCouple ? coupleAmount : 0,

        minorAmount: includesMinors ? minorAmount : 0,

        cost: singleAmount + (includesCouple ? coupleAmount : 0) + (includesMinors ? minorAmount : 0),

        found: result.found

    };

}



/*==========================================================
 6. RECARGO DE VISA A PARTIR DE LA TERCERA APLICACIÓN (ONSHORE)
 ----------------------------------------------------------
 Aplica solo si Onshore y número de aplicación > 2 — el nombre del
 parámetro en la hoja "Parametros" ("Recargo tercera aplicación visa
 (solo onshore)") es la fuente de verdad: la 1ra y 2da aplicación NO
 llevan este recargo, solo la 3ra en adelante.
 El monto es POR APLICANTE (regla confirmada por el cliente).
==========================================================*/

async function calculateSecondApplicationSurcharge({ application_type, application_number, number_applicants }) {

    const applies = application_type === "Onshore" && application_number > 2;

    if (!applies) {

        return {

            applies: false,

            perApplicantAmount: 0,

            numberApplicants: number_applicants,

            totalAmount: 0

        };

    }

    // Lleva el mismo 1.4% de tarjeta de crédito que el resto de Visa (ver
    // VISA_CREDIT_CARD_SURCHARGE_RATE más arriba) — este recargo es visa
    // también, aunque viva en un parámetro aparte.
    const perApplicantAmount = (await fetchSecondApplicationSurcharge()) * (1 + VISA_CREDIT_CARD_SURCHARGE_RATE);

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
 Decisión confirmada del cliente (reemplaza la regla anterior de
 "solo Offshore + país autorizado"): estos valores ahora SIEMPRE
 aparecen, en Onshore y en Offshore, sin importar el país del
 estudiante — el monto real depende de la nacionalidad y el
 historial migratorio de cada estudiante, algo que el cotizador
 no puede calcular; por eso se muestran siempre como valor
 genérico informativo, a confirmar por el equipo de visa antes de
 aplicar (ver el texto exacto en pdf.js#buildExtraCostsNoteText).
 El monto de cada examen (hoja "Parámetros") no cambia.

 IMPORTANTE: estos valores son informativos ("Costos Extras",
 se pagan directamente a cada entidad proveedora) y NUNCA deben
 sumarse al total principal — por eso NO se pasan a
 assembleTotals() y viajan aparte en quote.extraCosts.
==========================================================*/

async function calculateExtraCosts() {

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

        items,

        total: items.reduce((sum, item) => sum + item.amount, 0)

    };

}



/*==========================================================
 8. SERVICIOS OPCIONALES
 ----------------------------------------------------------
 AIRPORT PICKUP (decisión confirmada del cliente, 2026-10-07): ver
 database.js#fetchServiceCatalog/fetchAirportPickupRate. Sigue
 siendo un servicio NIVEL 1 (compartido entre todas las opciones de
 colegio, como SIM Card/Traducciones), pero su precio depende de la
 ciudad de estudio. resolveBestAirportPickupRate() mira los cursos
 de TODAS las opciones de la cotización (no solo una), resuelve la
 ciudad real de cada uno (igual que database.js#resolveCourseDisplayCity:
 si el curso usa el comodín "Todos los campus", la ciudad real es
 "Ciudad seleccionada por el estudiante") y usa la tarifa MÁS ALTA
 entre todas esas ciudades — mismo criterio que ya aplica para
 cualquier otro servicio compartido (un solo monto para toda la
 cotización). Si NINGUNA ciudad tiene fila de Airport Pickup
 configurada, el servicio se excluye de la cotización en silencio
 (aunque la asesora lo haya marcado) — no hay nada que cobrar ni que
 avisar, es información de catálogo faltante, no un error de la
 asesora.
==========================================================*/

function resolveCourseStudyCity(course) {

    return course.city === ALL_CITIES_OPTION ? (course.studentCity || "") : (course.city || "");

}

async function resolveBestAirportPickupRate(options) {

    const cities = new Set();

    (options || []).forEach(option => {

        (option.courses || []).forEach(course => {

            const city = resolveCourseStudyCity(course);

            if (city) cities.add(city);

        });

    });

    let best = null;

    for (const city of cities) {

        const rate = await fetchAirportPickupRate(city);

        if (rate.found && (!best || rate.amount > best.amount)) best = { city, amount: rate.amount };

    }

    return best;

}

async function calculateServicesLines(selectedServices, airportPickupRate) {

    if (!selectedServices || selectedServices.length === 0) return [];

    const catalog = await fetchServiceCatalog();

    return selectedServices

        .map(selected => {

            // "Servicio extra" (ver services.js#getSelectedServices): no tiene
            // fila en el catálogo, la asesora escribió descripción y valor a
            // mano. El nombre a mostrar es la descripción TAL CUAL la escribió
            // la asesora (decisión confirmada del cliente: en el PDF debe verse
            // solo esa descripción, sin el prefijo "Servicio extra –" ni ningún
            // otro texto agregado) — pdf.js además omite el sufijo "(xN)" para
            // estas líneas (ver isCustom ahí).
            if (selected.isCustom) {

                const label = selected.customLabel;

                return {

                    serviceCode: selected.serviceCode,

                    label,

                    shortLabel: label,

                    quantity: 1,

                    unitCost: selected.customValue,

                    subtotal: selected.customValue,

                    isCustom: true

                };

            }

            if (selected.serviceCode === AIRPORT_PICKUP_CODE) {

                // Ninguna ciudad de la cotización tiene tarifa configurada —
                // se excluye esta línea en vez de cobrar $0 (ver cabecera de
                // esta sección).
                if (!airportPickupRate) return null;

                const catalogEntry = catalog.find(entry => entry.code === AIRPORT_PICKUP_CODE);

                const quantity = selected.quantity || 1;

                return {

                    serviceCode: selected.serviceCode,

                    // Sin la ciudad en paréntesis (pedido explícito del
                    // cliente, 2026-10-07): el PDF debe decir solo "Airport
                    // Pickup", aunque el monto por dentro sí dependa de la
                    // ciudad resuelta (ver resolveBestAirportPickupRate).
                    // "+ SIM Card" (pedido explícito del cliente, 2026-10-09):
                    // toda recogida en aeropuerto regala la SIM Card, sin
                    // cobrar nada aparte (ver database.js#SIM_CARD_SERVICE_NAME
                    // — ya no existe como checkbox propio).
                    label: `${AIRPORT_PICKUP_PREFIX} + SIM Card`,

                    shortLabel: catalogEntry ? catalogEntry.shortLabel : AIRPORT_PICKUP_PREFIX,

                    quantity,

                    unitCost: airportPickupRate.amount,

                    subtotal: airportPickupRate.amount * quantity

                };

            }

            const catalogEntry = catalog.find(entry => entry.code === selected.serviceCode);

            const unitCost = catalogEntry ? catalogEntry.unitCost : 0;

            const label = catalogEntry ? catalogEntry.label : selected.serviceCode;

            // Ver database.js#fetchServiceCatalog — usada solo por
            // pdf.js#buildAdicionalesLabel para la fila dinámica del
            // comparativo, nunca para el desglose (que sigue usando "label").
            const shortLabel = catalogEntry ? catalogEntry.shortLabel : selected.serviceCode;

            const quantity = selected.quantity || 1;

            return {

                serviceCode: selected.serviceCode,

                label,

                shortLabel,

                quantity,

                unitCost,

                subtotal: unitCost * quantity

            };

        })

        .filter(Boolean);

}



/*==========================================================
 9. DESCUENTOS APLICADOS
 ----------------------------------------------------------
 El descuento por curso ya se resolvió en database.js
 (fetchCourseDetails -> buildCourseDiscountEffect). Aquí solo se
 recopila la lista de descuentos efectivamente aplicados, para
 mostrarlos en el resumen.
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

/*==========================================================
 7.2 PRIMER PAGO
 ----------------------------------------------------------
 Única fuente de verdad para este valor — alimenta por igual el
 comparativo/resumen en pantalla y el PDF (ninguno de los dos
 recalcula esto por su cuenta).

 Offshore: si el total de semanas de la opción es MENOR a 25,
 no existe "Primer Pago" en absoluto (pedido explícito del
 cliente: en ese caso solo se muestra TOTAL, ni en pantalla ni
 en PDF) — se devuelve `null`, no un número, para que
 summary.js/pdf.js puedan distinguir "no aplica" de "$0". Si son
 25 semanas o más, ver calculateOffshoreFirstPayment25Plus().

 Onshore: suma del depósito ya calculado de cada curso de la
 opción (ver applyOnshoreFirstPaymentDeposits — parametrizado por
 Colegio en la pestaña "Primer depósito Onshore", NUNCA una columna
 fija en Cursos), más Visa y Seguro médico. Nunca un único depósito
 para toda la opción: cada curso tiene el suyo, calculado como
 Base + su propia Matrícula + sus propios Materiales.

 En ambos casos, "Visa" es el MISMO valor ya calculado para el
 resto de la cotización (calculateVisa) MÁS el recargo desde la
 3ra aplicación si aplica (calculateSecondApplicationSurcharge)
 — nunca una segunda lógica de Visa independiente.
==========================================================*/

/*
    Fórmula pedida por el cliente (reemplaza el "50% de subtotalCursos"
    anterior, SOLO para Offshore ≥25 semanas):

      1. Programa = Σ line.price (curso solo, sin matrícula/materiales)
      2. Beneficio = Σ line.priceDiscount (SOLO el descuento de precio del
         curso — nunca el valor de matrícula/materiales gratis, que se
         suman aparte en el paso 4 ya en $0 si corresponde; ver
         database.js#fetchCourseDetails)
      3. (Programa - Beneficio) / 2
      4. + Matrícula y Materiales, cada una ya neta de AMBOS mecanismos
         de waiver: la regla de institución (line.enrollmentFee, ver
         applyInstitutionEnrollmentFeeRule) Y la promoción de matrícula/
         materiales gratis (line.enrollmentFeeWaivedAmount/
         materialsFeeWaivedAmount)
      5. + Otros Cargos COMPLETO: Seguro, Visa, recargo de aplicación,
         extras offshore y servicios/traducciones — todo lo que el PDF ya
         agrupa bajo "OTROS CARGOS" (ver pdf.js#buildCostTableSection)
*/

function calculateOffshoreFirstPayment25Plus({ courseLines, insurance, visa, secondApplicationSurcharge, offshoreExtras, servicesSubtotal }) {

    const programa = courseLines.reduce((sum, line) => sum + line.price, 0);

    const beneficio = courseLines.reduce((sum, line) => sum + line.priceDiscount, 0);

    const matricula = courseLines.reduce((sum, line) => sum + Math.max(0, line.enrollmentFee - line.enrollmentFeeWaivedAmount), 0);

    const materiales = courseLines.reduce((sum, line) => sum + Math.max(0, line.materialsFee - line.materialsFeeWaivedAmount), 0);

    const otrosCargos = insurance.cost + visa.cost + secondApplicationSurcharge.totalAmount + offshoreExtras.total + servicesSubtotal;

    return (programa - beneficio) / 2 + matricula + materiales + otrosCargos;

}

function calculateFirstPayment({ applicationType, totalWeeks, courseLines, insurance, visa, secondApplicationSurcharge, offshoreExtras, servicesSubtotal }) {

    if (applicationType === "Onshore") {

        const totalVisaCost = visa.cost + secondApplicationSurcharge.totalAmount;

        const depositsSum = courseLines.reduce((sum, line) => sum + (line.firstPaymentDeposit || 0), 0);

        return depositsSum + totalVisaCost + insurance.cost;

    }

    if (totalWeeks < 25) return null;

    return calculateOffshoreFirstPayment25Plus({ courseLines, insurance, visa, secondApplicationSurcharge, offshoreExtras, servicesSubtotal });

}

function assembleTotals({ courseLines, insurance, visa, secondApplicationSurcharge, offshoreExtras, servicesSubtotal, applicationType, totalWeeks }) {

    const subtotalCursos = courseLines.reduce((sum, line) => sum + line.price + line.enrollmentFee + line.materialsFee, 0);

    const descuento = courseLines.reduce((sum, line) => sum + line.discount, 0);

    const otrosCargos = insurance.cost + visa.cost;

    const adicionales = secondApplicationSurcharge.totalAmount + offshoreExtras.total + servicesSubtotal;

    const total = subtotalCursos + otrosCargos + adicionales - descuento;

    const primerPago = calculateFirstPayment({

        applicationType,

        totalWeeks,

        courseLines,

        insurance,

        visa,

        secondApplicationSurcharge,

        offshoreExtras,

        servicesSubtotal

    });

    return {

        subtotalCursos,

        otrosCargos,

        adicionales,

        descuento,

        total,

        primerPago

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

        if (course.cityRequired && !course.city) missingFields.push("Ciudad");

        // "Todos los campus" es solo la condición interna que habilita el
        // comodín de Ciudad (ver database.js#matchesCityFilter) — la ciudad
        // real que interesa al estudiante se registra aparte y es
        // obligatoria en ese caso (ver courses.js#toggleStudentCityField).
        if (course.city === ALL_CITIES_OPTION && !course.studentCity) {

            missingFields.push("Ciudad seleccionada por el estudiante");

        }

        if (!course.type) missingFields.push("Tipo de Curso");

        if (!course.program) missingFields.push("Programa");

        if (!course.schedule) missingFields.push("Horario de estudio");

        // En modo Manual, "Tiempo de estudio" (manualWeeks) reemplaza a
        // "Duración (semanas)" como fuente de las semanas ELICOS — ver
        // courses.js#createManualOverrideFields / calculateCourseLine.
        const hasManualWeeks = course.isManualOverride && Number(course.manualWeeks) > 0;

        if (course.type === "ELICOS" && !hasManualWeeks && (!course.weeks || Number(course.weeks) <= 0)) {

            missingFields.push("Duración (semanas)");

        }

        if (missingFields.length > 0) {

            warnings.push(`Curso #${index + 1}: falta diligenciar ${missingFields.join(", ")}.`);

        }

    });

    courseLines.forEach((line, index) => {

        // Modo Manual existe justo para cursos/programas que NO están en
        // la hoja "Cursos" (negociaciones especiales, programas nuevos) —
        // ver courses.js#createManualOverrideFields. Si está activo, que
        // el catálogo no tenga esa combinación es esperado, no un error
        // que deba bloquear "Generar Cotización" (decisión confirmada del
        // cliente, 2026-10-09).
        if (!line.found && line.college && line.program && !line.isManualOverride) {

            warnings.push(

                `Curso #${index + 1}: no se encontró esa combinación exacta en la hoja "Cursos". ` +

                `Verifica Colegio/Ciudad/Tipo/Programa/Rango de duración.`

            );

        }

        // Fila encontrada, pero sin tarifa semanal configurada para el
        // Horario/Tipo de Aplicación elegidos (ni la del Horario, ni el
        // respaldo general, ni un "Valor Semana" que la reemplace) — ver
        // database.js#fetchCourseDetails. Se avisa ANTES de generar en
        // vez de dejar pasar el curso en $0 en silencio (mismo principio
        // que firstPaymentDepositMissing, pedido explícito del cliente,
        // 2026-10-05).
        if (line.weeklyRateMissing) {

            warnings.push(

                `Curso #${index + 1}: "${line.college}" no tiene tarifa semanal configurada para el horario ` +

                `"${line.schedule}" (${student.application_type}). Verifica las columnas "Valor semana ..." ` +

                `en la hoja "Cursos".`

            );

        }

        // Onshore, condición de Primer Depósito no configurada para este
        // Colegio en la pestaña "Primer depósito Onshore" — ver
        // pricing.js#applyOnshoreFirstPaymentDeposits. Se avisa ANTES de
        // generar la cotización en vez de dejar el depósito en $0 en
        // silencio (decisión confirmada del cliente).
        if (line.firstPaymentDepositMissing) {

            warnings.push(

                `Curso #${index + 1}: falta configurar el Primer Depósito Onshore para "${line.college}" ` +

                `en la pestaña "Primer depósito Onshore".`

            );

        }

    });

    if (!student.insurance) {

        warnings.push("No se ha seleccionado un seguro médico.");

    } else if (!insurance.found) {

        warnings.push(

            `Seguro médico: no se encontró una tarifa para "${student.insurance}" con tipo de cotización ` +

            `"${student.quotation_type}" y duración ${insurance.totalWeeks} semana(s) en la hoja "Seguros". ` +

            `Verifica que exista una fila con esa duración exacta.`

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
