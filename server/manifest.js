const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const SHORTCUT_ICONS = [{ src: '/icons/icon-192.png', sizes: '192x192' }];

/** Басты экрандағы қысқа атау: мекеме атауы қысқа болса — сол, әйтпесе бірінші сөзі. */
function shortName(businessName, fallback) {
  if (businessName.length <= 12) return businessName;
  const first = businessName.split(' ')[0];
  return first.length >= 3 && first.length <= 12 ? first : fallback;
}

/**
 * PWA манифесі. Мекеме атауы баптаулардан алынады — орнатылған қосымша сол атпен көрінеді.
 * Үш қосымша: клиентке («Кезек»), әкімшіге («Әкімші») және кассирге («Касса»).
 * @param {'client' | 'admin' | 'kassa'} kind
 * @param {string} businessName
 */
export function buildManifest(kind, businessName) {
  const common = {
    lang: 'kk',
    dir: 'ltr',
    display: 'standalone',
    background_color: '#060b1a',
    theme_color: '#060b1a',
    icons: ICONS,
  };

  if (kind === 'admin') {
    return {
      ...common,
      id: '/admin/',
      name: `${businessName} — Әкімші`,
      short_name: 'Әкімші',
      description: 'Билет беру, кезек, есептер және баптаулар',
      start_url: '/admin/',
      scope: '/admin/',
      shortcuts: [
        { name: 'Кезек', url: '/admin/queue', icons: SHORTCUT_ICONS },
        { name: 'Есеп', url: '/admin/reports', icons: SHORTCUT_ICONS },
      ],
    };
  }

  if (kind === 'kassa') {
    return {
      ...common,
      id: '/kassa/',
      name: `${businessName} — Касса`,
      short_name: 'Касса',
      description: 'Билет беру және бүгінгі сатылым',
      start_url: '/kassa/',
      scope: '/kassa/',
      shortcuts: [{ name: 'Сатылым', url: '/kassa/sales', icons: SHORTCUT_ICONS }],
    };
  }

  return {
    ...common,
    id: '/',
    name: `${businessName} — Кезек`,
    short_name: shortName(businessName, 'Кезек'),
    description: 'Талоныңыз бен кезектегі орныңыз телефоныңызда',
    start_url: '/',
    scope: '/',
  };
}
