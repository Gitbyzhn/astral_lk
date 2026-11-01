const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/**
 * PWA манифесі. Мекеме атауы баптаулардан алынады — орнатылған қосымша сол атпен көрінеді.
 * Екі қосымша: клиентке («Кезек») және әкімшіге («Касса»).
 * @param {'client' | 'admin'} kind
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
      name: `${businessName} — Касса`,
      short_name: 'Касса',
      description: 'Билет беру, кезек және есептер',
      start_url: '/admin/',
      scope: '/admin/',
      shortcuts: [
        { name: 'Кезек', url: '/admin/queue', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        { name: 'Есеп', url: '/admin/reports', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      ],
    };
  }

  return {
    ...common,
    id: '/',
    name: `${businessName} — Кезек`,
    short_name: businessName.length <= 12 ? businessName : 'Кезек',
    description: 'Талоныңыз бен кезектегі орныңыз телефоныңызда',
    start_url: '/',
    scope: '/',
  };
}
