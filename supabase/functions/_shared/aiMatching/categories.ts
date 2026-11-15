// Human labels of the five tester categories (ids are the database allow-list, migration 6). The free-text questions and
// answers themselves belong to the profile/qualification workstream and arrive through its contract (see contract.ts).

export const CATEGORY_LABELS: Record<string, string> = {
  tech_savvy: 'Tech-Savvy Users',
  founders_builders: 'Founders & Product Builders',
  business_office: 'Business & Office Users',
  students_learners: 'Students & Learners',
  everyday_nontechnical: 'Everyday & Non-Technical Users',
};
