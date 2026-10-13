// Additional page-specific copy so that every page without a planted thin-content defect has a realistic amount of text.
export const clinicianFor = {
  'general-dentistry': ['Dr Amelia Hart', 'all three clinics'],
  'dental-implants': ['Dr Rohan Mehta', 'Bristol'],
  'teeth-whitening': ['Dr Sophie Lang', 'Bath and Bristol'],
  invisalign: ['Dr Sophie Lang', 'Bath'],
  hygiene: ['Priya Shah and our hygiene team', 'all three clinics'],
  'childrens-dentistry': ['Tom Ellis and our dental therapists', 'all three clinics'],
  veneers: ['Dr Sophie Lang', 'Bath'],
};
export const serviceExtra = (s) => {
  const [who, where] = clinicianFor[s.slug] || ['our dentists', 'all three clinics'];
  return `<h2>Who provides ${s.name.toLowerCase()}</h2>
<p>${who} leads this service, which is available at ${where}. Every clinician who treats you is registered with the General Dental Council, and you can ask to see the same person at each visit.</p>
<h2>Your first appointment</h2>
<p>We start with a conversation about what you would like to change and any worries you have, followed by an examination. You will leave with a written plan that sets out the options, how long each takes and the fee for each stage. There is no obligation to go ahead, and you can take the plan away to think about it.</p>
<h2>Questions worth asking</h2>
<p>Ask what the alternatives are, including doing nothing, how long the result is expected to last, and what the follow-up visits involve. Our team would much rather answer questions before treatment than after it.</p>`;
};
export const teamExtra = (t) => `<h2>Clinic days and how to book</h2>
<p>${t.name.split(' ').slice(-2).join(' ')} keeps a number of appointments free each week for new patients. Our receptionists can tell you the next available slot and whether an early or late appointment is possible.</p>
<h2>What patients can expect</h2>
<p>Every appointment begins with a check on your medical history and a chance to raise anything that is worrying you. Treatment options are explained with photographs or X-rays on the screen, and costs are confirmed in writing before any treatment starts. If you are anxious, say so when you book and extra time will be allowed.</p>
<h2>Professional registration</h2>
<p>All Harbourline clinicians are registered with the General Dental Council and complete continuing professional development every year. You can check any dental professional on the public GDC register.</p>`;
export const locationExtra = (l) => `<h2>Facilities at ${l.city}</h2>
<p>The ${l.city} clinic has a fully accessible toilet, a hearing loop at reception and baby-changing facilities. Free drinking water is available in the waiting room. Card payments, including contactless, are taken at the desk.</p>
<h2>Booking at ${l.city}</h2>
<p>You can book online or by phoning the clinic on ${l.phone}. Existing patients in pain should call from 8am for an emergency appointment the same day. New patients are welcome, and the first appointment lasts forty minutes so there is time to talk through your history and any concerns.</p>`;
export const pageExtra = {
  '/': `<section aria-labelledby="h-new">
<h2 id="h-new">New to Harbourline?</h2>
<p>Your first visit is a forty-minute appointment with a dentist and costs £75, including any X-rays. We ask about your medical history, check your teeth, gums and the soft tissues of your mouth, and explain what we find. You leave with a written plan and fees, and there is never any pressure to start treatment that day.</p>
<p>If you have been away from the dentist for a long time, you are not alone and you will not be lectured. Tell us when you book and we will allow extra time.</p>
</section>`,
  '/services': `<h2>Emergency appointments</h2>
<p>Every clinic keeps emergency appointments free each weekday morning for patients in pain, with swelling or with a broken tooth. Call from 8am to be seen the same day.</p>`,
  '/team': `<h2>Dental nurses and reception</h2>
<p>Behind every appointment is a dental nurse who prepares the surgery, sterilises instruments and helps during treatment, and a reception team who manage bookings and payments. Many of our nurses hold extra qualifications in radiography, oral health education or sedation nursing, and several have worked with us for more than ten years. You will meet them at every visit, and they are always happy to answer questions about appointments and aftercare.</p>`,
  '/locations': `<h2>Opening hours</h2>
<p>Bristol is open Monday to Friday from 8am to 7pm and on Saturday mornings. Bath opens from 7.30am Monday to Thursday and closes at 4pm on Fridays. Leeds is open Tuesday to Friday and on alternate Saturday mornings. Each clinic page lists exact hours, travel directions and parking.</p>`,
  '/about': `<h2>Our team today</h2>
<p>Twenty-two people now work across the three clinics: five dentists, four hygienists and therapists, eight dental nurses and a reception and management team. Most have been with us for more than five years, which is one reason patients tell us they see familiar faces at each visit.</p>
<p>We train dental nurses from scratch, support nurses who want to become hygienists, and host dental students from Bristol for observation placements twice a year.</p>`,
  '/contact': `<h2>Writing to us</h2>
<p>Letters can be sent to the practice manager at Harbourline Dental Studio, 14 Quay Street, Bristol BS1 4DB. We aim to reply to letters within five working days. For questions about an invoice, please quote the reference shown on your receipt so that we can find your record quickly.</p>
<p>If your question is about a complaint, please see our complaints procedure, which explains how we handle concerns and how quickly we respond.</p>`,
  '/pricing': `<h2>Why we publish our fees</h2>
<p>We think patients should be able to compare prices before booking. The table above lists our standard fees. Complex cases, such as implants with bone grafting or full-mouth treatment, are priced individually after a consultation, and the written plan you receive sets out each stage separately. If a fee changes during a course of treatment, we explain why before continuing, and we never add charges without your agreement.</p>
<p>Children under eighteen are seen free for check-ups when a parent or guardian is a registered patient.</p>`,
  '/book': `<h2>Choosing the right appointment</h2>
<p>Choose check-up if you are an existing patient due a routine examination, or if you are new to the practice. Choose hygiene for a scale and polish or gum treatment with one of our hygienists. Choose consultation if you would like to discuss implants, aligners, whitening or veneers. If none of these fit, choose check-up and add a note when we call you.</p>
<p>Appointments requested before 3pm on a weekday are usually confirmed the same day. We will never book an appointment without speaking to you or emailing you first.</p>
<h2>Cancelling or changing an appointment</h2>
<p>Please give at least two working days’ notice so that we can offer the time to someone else. You can change an appointment by replying to your confirmation email or by phoning the clinic.</p>`,
  '/new-patients': `<h2>Medical history</h2>
<p>Before your first visit we email a short medical history form. It asks about medicines, allergies, heart conditions, diabetes, pregnancy and anything else that could affect dental treatment. Completing it at home saves about ten minutes at the appointment and lets the dentist read it beforehand.</p>
<h2>Fees for new patients</h2>
<p>The new patient appointment costs £75 and includes any X-rays that are needed. Children of registered patients are seen free. Any treatment you choose to go ahead with is priced in your written plan before it begins.</p>`,
  '/us/new-patients': `<p>Many American visitors are surprised that a private dental visit in the UK costs less than they expect. Fees are listed on our prices page in pounds, and we are happy to give an estimate in dollars at the current exchange rate before you commit.</p>`,
  '/invisalign-guide': `<h2>Is it painful?</h2>
<p>Most people describe pressure rather than pain for a day or two after each new set. Over-the-counter painkillers are rarely needed after the first week, and the aligners themselves are smooth and do not rub like brackets.</p>`,
  '/us/invisalign-guide': `<h2>Wearing time abroad</h2>
<p>Travel, new food and long workdays make it easy to forget your trays. Set a reminder on your phone for after each meal, carry a spare case, and keep your previous set in case one is lost. Wear time matters more than anything else in keeping treatment on schedule.</p>`,
  '/legal/cookies': `<h2>Third parties</h2>
<p>This website does not load advertising, social media or analytics scripts from other companies. Embedded maps on clinic pages are served from our own server rather than from a mapping provider.</p>`,
  '/legal/terms': `<h2>Changes to these terms</h2>
<p>We review these terms each year. If we change them, the new terms apply to treatment plans issued after the change, and we will tell you about any change that affects treatment you have already agreed.</p>`,
  '/legal/complaints': `<p>Making a complaint will never affect the care you receive from us. If you would prefer to be seen by a different clinician while a complaint is investigated, we will arrange it.</p>`,
  '/legal/accessibility': `<h2>How we test</h2>
<p>We check new pages with automated tools and by hand, using a keyboard only, with screen magnification at 400 per cent and with a screen reader on desktop and mobile. Patients who use assistive technology have also reviewed the booking form and the clinic pages for us.</p>
<h2>Known limitations</h2>
<p>Some older PDF leaflets linked from treatment pages are not fully accessible to screen readers. We are replacing them with web pages during 2026, and in the meantime we can send any leaflet in an accessible format on request.</p>
<p>Videos on this site have captions. A small number of photographs in older articles have short descriptions only; we are reviewing these as we update each article.</p>`,
  '/careers': `<h2>Our recruitment process</h2>
<p>Shortlisted candidates are invited to an informal visit before the interview, so you can meet the team and see the clinic working. Interviews last about forty-five minutes and are held with the clinic lead and the practice manager. For clinical roles there is a short practical discussion rather than a test. We confirm decisions within a week of the interview.</p>
<h2>What it is like to work here</h2>
<p>Appointments are booked with realistic time so that nobody has to rush, lunch breaks are protected and the clinics close on time. We hold a team meeting each month where anyone can raise ideas, and many of the changes made at the practice in recent years started as suggestions from nurses and receptionists.</p>`,
  '/finance': `<h2>Refunds</h2>
<p>If you pay in advance for a course of treatment and then decide not to continue, we refund any amount paid for treatment not yet carried out, less laboratory costs already incurred. Refunds are made to the card you paid with, normally within ten working days.</p>
<h2>Deposits for laboratory work</h2>
<p>Crowns, bridges, veneers and dentures are made by a dental laboratory. We ask for a deposit of half the fee when the scan or impression is taken, with the balance due when the work is fitted. If the work cannot be fitted for clinical reasons, the deposit is refunded less any laboratory costs already incurred.</p>`,
  '/referrals': `<h2>Communication</h2>
<p>Each referring practice has a named contact at Harbourline. You can phone or email them to discuss a case before referring, to check progress, or to ask for copies of radiographs and photographs. We also run two evening study sessions a year for local dentists on implant and aligner case selection, which count towards verifiable CPD.</p>
<h2>Sharing care</h2>
<p>Referred patients remain your patients. We only carry out the treatment requested in the referral unless we find something urgent, in which case we contact you before acting. When treatment is complete, we send the patient back with clear maintenance instructions and any recommended review intervals.</p>`,
  '/developers': `<h2>Versioning and changes</h2>
<p>The pilot API is versioned in the URL. We give at least ninety days’ notice by email before retiring a version, and we announce new fields on this page. During the pilot we may change response formats after giving thirty days’ notice to registered developers.</p>
<h2>Data and privacy</h2>
<p>The availability API never exposes patient names, contact details or clinical information. Appointment requests made through partner applications are treated exactly like requests from our own booking form: a receptionist confirms the details with the patient before anything is booked. We log API requests for thirty days for security monitoring and then delete them.</p>`,
};
export const archiveExtra = {
  cosmetic: `<h2>About cosmetic treatment at Harbourline</h2>
<p>Cosmetic dentistry covers treatment that changes how teeth look rather than treating disease. We always check that teeth and gums are healthy first, and we favour the least invasive option that achieves what you want, such as straightening and whitening before veneers. Every cosmetic plan starts with photographs and a written estimate.</p>`,
  whitening: `<h2>Booking a whitening consultation</h2>
<p>A whitening consultation includes a check-up, a shade record and a discussion of what result is realistic for your teeth. Fees are on our prices page.</p>`,
  kids: `<h2>Free check-ups for children</h2>
<p>Children under eighteen are seen free for check-ups at every Harbourline clinic when a parent or guardian is a registered patient. Appointments are short, and we can book siblings back to back so the whole family is seen in one visit. Bring your child’s red book or vaccination record to the first visit if it is handy.</p>`,
  'oral-health': '',
  news: '',
};
