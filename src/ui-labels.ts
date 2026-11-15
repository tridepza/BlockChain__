const categoryLabels: Readonly<Record<string, string>> = {
  'Web Development': 'Phát triển web',
  'UI/UX Design': 'Thiết kế UI/UX',
  'Data Analytics': 'Phân tích dữ liệu',
  'Mobile App': 'Ứng dụng di động',
};

export const categoryLabel = (category: string) => categoryLabels[category] ?? category;
