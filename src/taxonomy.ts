export interface DefaultCategoryDef {
  name: string;
  color: string;
  isSystem: boolean;
  keywords: string[];
}

export const DEFAULT_CATEGORIES: DefaultCategoryDef[] = [
  {
    name: 'Groceries',
    color: '#10B981', // emerald
    isSystem: true,
    keywords: [
      'trader joe', 'whole foods', 'kroger', 'safeway', 'costco', 'aldi', 'wegmans',
      'heb', 'supermarket', 'market basket', 'publix', 'food lion', 'sprouts', 'target grocery'
    ]
  },
  {
    name: 'Dining',
    color: '#F59E0B', // amber
    isSystem: true,
    keywords: [
      'starbucks', 'mcdonald', 'chipotle', 'sweetgreen', 'dunkin', 'uber eats',
      'doordash', 'grubhub', 'shake shack', 'burger', 'pizza', 'bakery', 'cafe',
      'coffee', 'taco', 'restaurant', 'sushi', 'diner', 'bistro'
    ]
  },
  {
    name: 'Shopping',
    color: '#3B82F6', // blue
    isSystem: true,
    keywords: [
      'amazon', 'target', 'walmart', 'best buy', 'apple', 'ebay', 'ikea',
      'clothing', 'zara', 'h&m', 'nordstrom', 'tj maxx', 'marshalls', 'home depot', 'lowes'
    ]
  },
  {
    name: 'Transport',
    color: '#8B5CF6', // purple
    isSystem: true,
    keywords: [
      'uber', 'lyft', 'mta', 'subway', 'metro', 'transit', 'caltrain', 'amtrak',
      'parking', 'toll', 'ezpass', 'taxi'
    ]
  },
  {
    name: 'Gas',
    color: '#EF4444', // red
    isSystem: true,
    keywords: [
      'shell', 'chevron', 'exxon', 'mobil', 'bp', 'texaco', 'sunoco',
      'speedway', 'wawa', 'tesla supercharger', 'gas'
    ]
  },
  {
    name: 'Subscriptions',
    color: '#EC4899', // pink
    isSystem: true,
    keywords: [
      'netflix', 'spotify', 'hulu', 'disney', 'youtube', 'github', 'openai',
      'chatgpt', 'audible', 'hbo', 'prime video', 'apple music', 'patreon'
    ]
  },
  {
    name: 'Utilities',
    color: '#06B6D4', // cyan
    isSystem: true,
    keywords: [
      'electric', 'water', 'gas company', 'coned', 'pge', 'national grid',
      'verizon', 'at&t', 't-mobile', 'spectrum', 'comcast', 'xfinity', 'internet'
    ]
  },
  {
    name: 'Housing',
    color: '#6366F1', // indigo
    isSystem: true,
    keywords: ['rent', 'mortgage', 'hoa', 'property tax', 'lease']
  },
  {
    name: 'Health',
    color: '#14B8A6', // teal
    isSystem: true,
    keywords: [
      'cvs', 'walgreens', 'pharmacy', 'clinic', 'dental', 'doctor', 'hospital',
      'planet fitness', 'equinox', 'gym', 'fitness', 'optometry'
    ]
  },
  {
    name: 'Travel',
    color: '#F97316', // orange
    isSystem: true,
    keywords: [
      'airline', 'delta', 'united', 'american air', 'southwest', 'jetblue',
      'hotel', 'marriott', 'hilton', 'airbnb', 'expedia', 'booking.com'
    ]
  },
  {
    name: 'Entertainment',
    color: '#A855F7', // violet
    isSystem: true,
    keywords: ['amc', 'cinema', 'theater', 'bowling', 'ticketmaster', 'museum', 'concert', 'steam', 'playstation', 'nintendo']
  },
  {
    name: 'Fees',
    color: '#9CA3AF', // gray
    isSystem: true,
    keywords: ['fee', 'service charge', 'annual fee', 'interest charge', 'late fee']
  },
  {
    name: 'Kids',
    color: '#FB7185', // rose
    isSystem: true,
    keywords: ['daycare', 'childcare', 'kindercare', 'tutoring']
  },
  {
    name: 'Insurance',
    color: '#0EA5E9', // sky
    isSystem: true,
    keywords: ['insurance', 'geico', 'progressive', 'state farm', 'allstate', 'liberty mutual']
  },
  {
    name: 'Gifts & Donations',
    color: '#D946EF', // fuchsia
    isSystem: true,
    keywords: ['donation', 'charity', 'gofundme']
  },
  {
    // Assigned by the transfer matcher to payments for cards we never import
    name: 'Credit card (untracked)',
    color: '#78716C', // stone
    isSystem: true,
    keywords: []
  },
  {
    // Assigned from kind = transfer, never by keyword: a keyword such as "payment"
    // would put real spending like "Venmo payment" into Transfer
    name: 'Transfer',
    color: '#64748B', // slate
    isSystem: true,
    keywords: []
  },
  {
    // Assigned from kind = income, never by keyword
    name: 'Income',
    color: '#22C55E', // green
    isSystem: true,
    keywords: []
  },
  {
    name: 'Uncategorized',
    color: '#CBD5E1', // light slate
    isSystem: true,
    keywords: []
  }
];

export const CHASE_CATEGORY_MAP: Record<string, string> = {
  'food & drink': 'Dining',
  'groceries': 'Groceries',
  'gas': 'Gas',
  'shopping': 'Shopping',
  'travel': 'Travel',
  'bills & utilities': 'Utilities',
  'health & wellness': 'Health',
  'entertainment': 'Entertainment',
  'fees & adjustments': 'Fees',
  'automotive': 'Transport',
  'home': 'Housing',
  'personal': 'Shopping',
  'professional services': 'Utilities',
  'gifts & donations': 'Gifts & Donations'
};
