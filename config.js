// Cloud sync settings. The publishable key is meant to be public: iPads can only upload
// through pos_push_orders (checked against each outlet's device key), and only owners
// listed in pos_admins can read data.
const CLOUD = {
  url: 'https://xiwabibuaktagsudxqac.supabase.co',
  key: 'sb_publishable_U1ExztYURiTLDktmRA4KXQ_1ojiRmPi',
};

// tables: how many tables the default floor plan starts with (staff can rearrange it on the iPad).
const OUTLETS = [
  { id: 'bsd', name: 'Bandar Sri Damansara', tables: 32, addr: 'No. 6-G Jalan Cempaka SD 12/2,\nBandar Sri Damansara, 52200 Kuala Lumpur' },
  { id: 'kepong', name: 'Kepong', tables: 30, addr: 'No. C-G-12, Fortune Avenue Kepong,\nJalan Metro Perdana 3, Taman Usahawan Kepong, 52100 Kuala Lumpur' },
];
