import { otherCategory } from './workflow';

const categoryLabels: Readonly<Record<string, string>> = {
  'Web Development': 'Phát triển web',
  'UI/UX Design': 'Thiết kế UI/UX',
  'Data Analytics': 'Phân tích dữ liệu',
  'Mobile App': 'Ứng dụng di động',
  [otherCategory]: 'Khác',
};

export const categoryLabel = (category: string) =>
  Object.prototype.hasOwnProperty.call(categoryLabels, category) ? categoryLabels[category] : category;
