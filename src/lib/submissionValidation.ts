export type SubmissionType = 'personnel' | 'synthetic' | 'entity' | 'article';
export type RequiredSubmissionField = 'title' | 'author' | 'employeeID' | 'syntheticID';
export type RequiredSubmissionValues = Record<RequiredSubmissionField, string>;

export function getMissingRequiredFields(type: SubmissionType, values: RequiredSubmissionValues) {
  const required: { field: RequiredSubmissionField; label: string }[] = [
    { field: 'title', label: type === 'entity' ? 'Entity number' : type === 'article' ? 'Report title' : 'Name' },
    { field: 'author', label: 'Author / owner credit' },
  ];

  if (type === 'personnel') required.push({ field: 'employeeID', label: 'Employee ID' });
  if (type === 'synthetic') required.push({ field: 'syntheticID', label: 'Synthetic ID' });

  return required.filter(({ field }) => !values[field].trim());
}
