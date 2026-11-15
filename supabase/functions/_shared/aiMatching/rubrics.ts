// Transparent, category-specific criteria for the professional-experience assessment (rubric r1).
//
// PURPOSE. Decide whether a tester's four free-text answers contain PLAUSIBLE, RELEVANT, SUFFICIENTLY SUBSTANTIVE self-reported
// experience for a professional category. It is NOT an exam and NOT a credential check:
//  * no degree, school, employer, job title, years of experience or "advanced" expertise is ever required;
//  * small, personal, informal and hobby experience counts;
//  * an honest "I have little experience" is a valid answer and is never treated as a failure of the tester;
//  * the result is "assessed from self-reported experience", never "verified".
// These strings are shown to testers (the Edge Function returns them with every result) and are the exact text the model is given.

import type { ProfessionalCategory } from './types.ts';

export const RUBRIC_VERSION = 'r1';

export interface Rubric {
  label: string;
  /** What the four questions are about, in one line (the model must use the question text it is given). */
  focus: string;
  criteria: Array<{ id: string; text: string }>;
}

export const RUBRICS: Record<ProfessionalCategory, Rubric> = {
  tech_savvy: {
    label: 'Tech-Savvy Users',
    focus: 'hands-on use of technology beyond everyday consumer use',
    criteria: [
      { id: 'c1', text: 'Names specific technologies, tools, software or devices they have actually used.' },
      { id: 'c2', text: 'Describes something technical they built, configured, automated or fixed, including what they personally did.' },
      { id: 'c3', text: 'Describes how they approached a real technical problem (what they tried, how they found the cause).' },
      { id: 'c4', text: 'Explains which technical products they can test well and why, consistent with what they reported.' },
    ],
  },
  founders_builders: {
    label: 'Founders & Product Builders',
    focus: 'involvement in building, launching or running a product or project (any scale)',
    criteria: [
      { id: 'c1', text: 'Describes a product, startup or side project they built, launched or helped build, and their own role. Small or personal projects count.' },
      { id: 'c2', text: 'Names tools or routines they use to plan, design, build, launch or measure a product.' },
      { id: 'c3', text: 'Describes a concrete product decision or trade-off and how they decided.' },
      { id: 'c4', text: 'Explains which products or user journeys they can give useful feedback on and why.' },
    ],
  },
  business_office: {
    label: 'Business & Office Users',
    focus: 'real work done with software in a business or office setting',
    criteria: [
      { id: 'c1', text: 'Describes real work they do or did in a business or office setting (no employer names needed).' },
      { id: 'c2', text: 'Names business or office tools they use regularly.' },
      { id: 'c3', text: 'Describes a concrete work process they carry out with software.' },
      { id: 'c4', text: 'Names kinds of business software they know and what they find frustrating about them.' },
    ],
  },
};

export const RUBRIC_PRINCIPLES = [
  'We look for concrete, plausible, self-reported experience in your own words.',
  'You do not need a degree, a job title, an employer, years of experience or advanced expertise. Small and informal experience counts.',
  'Please only write what is true. If you have little experience, say so: you can still take open tasks and use the other categories.',
  'This is an assessment of your self-reported answers, not a verification of any credential.',
];

export const DEFAULT_CLARIFICATION: Record<ProfessionalCategory, string[]> = {
  tech_savvy: ['Which specific tools or technologies have you actually used, and for what?', 'Can you describe one concrete thing you built, set up or fixed, and what you did yourself?'],
  founders_builders: ['What did you personally do on a product or project you worked on?', 'Which tools or routines did you use to plan, build or measure it?'],
  business_office: ['What does your day-to-day work involve, and which software do you use for it?', 'Can you walk through one task you do with that software, step by step?'],
};
