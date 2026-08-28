// ─── Country Dial Codes ───────────────────────────────────────────────────────
// flag  – emoji flag (rendered natively on iOS/Android/Web)
// name  – country name
// code  – ISO 3166-1 alpha-2
// dial  – ITU-T E.164 calling code (without leading +)

export interface Country {
  flag: string;
  name: string;
  code: string;
  dial: string;
  /** Expected local number digit count (without country code) */
  digits: number;
  /** Group sizes for display formatting e.g. [3,3,4] → "071 234 5678" */
  groups: number[];
}

export const COUNTRIES: Country[] = [
  { flag: '🇦🇫', name: 'Afghanistan',                        code: 'AF', dial: '93',   digits: 9,  groups: [2,3,4]   }, // Middle East / South Asia
  { flag: '🇦🇱', name: 'Albania',                            code: 'AL', dial: '355',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇩🇿', name: 'Algeria',                            code: 'DZ', dial: '213',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇦🇸', name: 'American Samoa',                     code: 'AS', dial: '1684', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇦🇩', name: 'Andorra',                            code: 'AD', dial: '376',  digits: 6,  groups: [3,3]     }, // Small European microstate
  { flag: '🇦🇴', name: 'Angola',                             code: 'AO', dial: '244',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇦🇮', name: 'Anguilla',                           code: 'AI', dial: '1264', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇦🇬', name: 'Antigua & Barbuda',                  code: 'AG', dial: '1268', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇦🇷', name: 'Argentina',                          code: 'AR', dial: '54',   digits: 10, groups: [3,3,4]   }, // Latin America
  { flag: '🇦🇲', name: 'Armenia',                            code: 'AM', dial: '374',  digits: 8,  groups: [2,3,3]   }, // Eastern Europe
  { flag: '🇦🇼', name: 'Aruba',                              code: 'AW', dial: '297',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇦🇺', name: 'Australia',                          code: 'AU', dial: '61',   digits: 9,  groups: [3,3,3]   }, // Australia (mobile: 04XX XXX XXX → 9 local digits)
  { flag: '🇦🇹', name: 'Austria',                            code: 'AT', dial: '43',   digits: 10, groups: [3,4,3]   }, // Europe – mobile 10 digits
  { flag: '🇦🇿', name: 'Azerbaijan',                         code: 'AZ', dial: '994',  digits: 9,  groups: [2,3,4]   }, // Middle East region
  { flag: '🇧🇸', name: 'Bahamas',                            code: 'BS', dial: '1242', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇧🇭', name: 'Bahrain',                            code: 'BH', dial: '973',  digits: 8,  groups: [4,4]     }, // Middle East – 8 digits
  { flag: '🇧🇩', name: 'Bangladesh',                         code: 'BD', dial: '880',  digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇧🇧', name: 'Barbados',                           code: 'BB', dial: '1246', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇧🇾', name: 'Belarus',                            code: 'BY', dial: '375',  digits: 9,  groups: [2,3,4]   }, // Eastern Europe
  { flag: '🇧🇪', name: 'Belgium',                            code: 'BE', dial: '32',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇧🇿', name: 'Belize',                             code: 'BZ', dial: '501',  digits: 7,  groups: [3,4]     }, // Small island/Central America
  { flag: '🇧🇯', name: 'Benin',                              code: 'BJ', dial: '229',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇧🇲', name: 'Bermuda',                            code: 'BM', dial: '1441', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇧🇹', name: 'Bhutan',                             code: 'BT', dial: '975',  digits: 8,  groups: [2,3,3]   }, // Asia – 8 digits
  { flag: '🇧🇴', name: 'Bolivia',                            code: 'BO', dial: '591',  digits: 8,  groups: [4,4]     }, // Latin America – 8 digits local
  { flag: '🇧🇦', name: 'Bosnia & Herzegovina',               code: 'BA', dial: '387',  digits: 8,  groups: [2,3,3]   }, // Europe
  { flag: '🇧🇼', name: 'Botswana',                           code: 'BW', dial: '267',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇧🇷', name: 'Brazil',                             code: 'BR', dial: '55',   digits: 11, groups: [2,5,4]   }, // Brazil specific
  { flag: '🇮🇴', name: 'British Indian Ocean Territory',     code: 'IO', dial: '246',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇻🇬', name: 'British Virgin Islands',             code: 'VG', dial: '1284', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇧🇳', name: 'Brunei',                             code: 'BN', dial: '673',  digits: 7,  groups: [3,4]     }, // Asia – 7 digits
  { flag: '🇧🇬', name: 'Bulgaria',                           code: 'BG', dial: '359',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇧🇫', name: 'Burkina Faso',                       code: 'BF', dial: '226',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇧🇮', name: 'Burundi',                            code: 'BI', dial: '257',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇰🇭', name: 'Cambodia',                           code: 'KH', dial: '855',  digits: 9,  groups: [2,3,4]   }, // Asia
  { flag: '🇨🇲', name: 'Cameroon',                           code: 'CM', dial: '237',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇨🇦', name: 'Canada',                             code: 'CA', dial: '1',    digits: 10, groups: [3,3,4]   }, // North America
  { flag: '🇨🇻', name: 'Cape Verde',                         code: 'CV', dial: '238',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇰🇾', name: 'Cayman Islands',                     code: 'KY', dial: '1345', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇨🇫', name: 'Central African Republic',           code: 'CF', dial: '236',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇹🇩', name: 'Chad',                               code: 'TD', dial: '235',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇨🇱', name: 'Chile',                              code: 'CL', dial: '56',   digits: 9,  groups: [3,3,3]   }, // Latin America
  { flag: '🇨🇳', name: 'China',                              code: 'CN', dial: '86',   digits: 11, groups: [3,4,4]   }, // China specific
  { flag: '🇨🇽', name: 'Christmas Island',                   code: 'CX', dial: '61',   digits: 9,  groups: [3,3,3]   }, // Uses Australian format
  { flag: '🇨🇨', name: 'Cocos Islands',                      code: 'CC', dial: '61',   digits: 9,  groups: [3,3,3]   }, // Uses Australian format
  { flag: '🇨🇴', name: 'Colombia',                           code: 'CO', dial: '57',   digits: 10, groups: [3,3,4]   }, // Latin America
  { flag: '🇰🇲', name: 'Comoros',                            code: 'KM', dial: '269',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇨🇬', name: 'Congo - Brazzaville',                code: 'CG', dial: '242',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇨🇩', name: 'Congo - Kinshasa',                   code: 'CD', dial: '243',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇨🇰', name: 'Cook Islands',                       code: 'CK', dial: '682',  digits: 5,  groups: [2,3]     }, // Small island – 5 digits
  { flag: '🇨🇷', name: 'Costa Rica',                         code: 'CR', dial: '506',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇭🇷', name: 'Croatia',                            code: 'HR', dial: '385',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇨🇺', name: 'Cuba',                               code: 'CU', dial: '53',   digits: 8,  groups: [4,4]     }, // Latin America – 8 digits
  { flag: '🇨🇼', name: 'Curaçao',                            code: 'CW', dial: '599',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇨🇾', name: 'Cyprus',                             code: 'CY', dial: '357',  digits: 8,  groups: [4,4]     }, // Europe – 8 digits
  { flag: '🇨🇿', name: 'Czechia',                            code: 'CZ', dial: '420',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇩🇰', name: 'Denmark',                            code: 'DK', dial: '45',   digits: 8,  groups: [2,2,2,2] }, // Europe – 8 digits, grouped as pairs
  { flag: '🇩🇯', name: 'Djibouti',                           code: 'DJ', dial: '253',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇩🇲', name: 'Dominica',                           code: 'DM', dial: '1767', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇩🇴', name: 'Dominican Republic',                 code: 'DO', dial: '1809', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇪🇨', name: 'Ecuador',                            code: 'EC', dial: '593',  digits: 9,  groups: [3,3,3]   }, // Latin America
  { flag: '🇪🇬', name: 'Egypt',                              code: 'EG', dial: '20',   digits: 10, groups: [3,3,4]   }, // Middle East/Africa
  { flag: '🇸🇻', name: 'El Salvador',                        code: 'SV', dial: '503',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇬🇶', name: 'Equatorial Guinea',                  code: 'GQ', dial: '240',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇪🇷', name: 'Eritrea',                            code: 'ER', dial: '291',  digits: 7,  groups: [3,4]     }, // Africa – 7 digits
  { flag: '🇪🇪', name: 'Estonia',                            code: 'EE', dial: '372',  digits: 7,  groups: [3,4]     }, // Europe – 7 digits
  { flag: '🇸🇿', name: 'Eswatini',                           code: 'SZ', dial: '268',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇪🇹', name: 'Ethiopia',                           code: 'ET', dial: '251',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇫🇰', name: 'Falkland Islands',                   code: 'FK', dial: '500',  digits: 5,  groups: [2,3]     }, // Small island
  { flag: '🇫🇴', name: 'Faroe Islands',                      code: 'FO', dial: '298',  digits: 6,  groups: [3,3]     }, // Small island – 6 digits
  { flag: '🇫🇯', name: 'Fiji',                               code: 'FJ', dial: '679',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇫🇮', name: 'Finland',                            code: 'FI', dial: '358',  digits: 10, groups: [3,3,4]   }, // Europe – mobile up to 10
  { flag: '🇫🇷', name: 'France',                             code: 'FR', dial: '33',   digits: 9,  groups: [2,2,2,2,1] }, // France specific
  { flag: '🇬🇫', name: 'French Guiana',                      code: 'GF', dial: '594',  digits: 9,  groups: [2,2,2,2,1] }, // Uses French format
  { flag: '🇵🇫', name: 'French Polynesia',                   code: 'PF', dial: '689',  digits: 8,  groups: [2,2,2,2] }, // French overseas – 8 digits
  { flag: '🇬🇦', name: 'Gabon',                              code: 'GA', dial: '241',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇬🇲', name: 'Gambia',                             code: 'GM', dial: '220',  digits: 7,  groups: [3,4]     }, // Africa – 7 digits
  { flag: '🇬🇪', name: 'Georgia',                            code: 'GE', dial: '995',  digits: 9,  groups: [3,3,3]   }, // Eastern Europe
  { flag: '🇩🇪', name: 'Germany',                            code: 'DE', dial: '49',   digits: 11, groups: [3,4,4]   }, // Germany specific
  { flag: '🇬🇭', name: 'Ghana',                              code: 'GH', dial: '233',  digits: 9,  groups: [2,3,4]   }, // Ghana specific
  { flag: '🇬🇮', name: 'Gibraltar',                          code: 'GI', dial: '350',  digits: 8,  groups: [4,4]     }, // Small – 8 digits
  { flag: '🇬🇷', name: 'Greece',                             code: 'GR', dial: '30',   digits: 10, groups: [3,3,4]   }, // Europe – 10 digits
  { flag: '🇬🇱', name: 'Greenland',                          code: 'GL', dial: '299',  digits: 6,  groups: [3,3]     }, // Small island – 6 digits
  { flag: '🇬🇩', name: 'Grenada',                            code: 'GD', dial: '1473', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇬🇵', name: 'Guadeloupe',                         code: 'GP', dial: '590',  digits: 9,  groups: [2,2,2,2,1] }, // Uses French format
  { flag: '🇬🇺', name: 'Guam',                               code: 'GU', dial: '1671', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇬🇹', name: 'Guatemala',                          code: 'GT', dial: '502',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇬🇳', name: 'Guinea',                             code: 'GN', dial: '224',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇬🇼', name: 'Guinea-Bissau',                      code: 'GW', dial: '245',  digits: 7,  groups: [3,4]     }, // Africa – 7 digits
  { flag: '🇬🇾', name: 'Guyana',                             code: 'GY', dial: '592',  digits: 7,  groups: [3,4]     }, // Small island/South America
  { flag: '🇭🇹', name: 'Haiti',                              code: 'HT', dial: '509',  digits: 8,  groups: [4,4]     }, // Caribbean – 8 digits
  { flag: '🇭🇳', name: 'Honduras',                           code: 'HN', dial: '504',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇭🇰', name: 'Hong Kong',                          code: 'HK', dial: '852',  digits: 8,  groups: [4,4]     }, // Asia – 8 digits
  { flag: '🇭🇺', name: 'Hungary',                            code: 'HU', dial: '36',   digits: 9,  groups: [2,3,4]   }, // Europe
  { flag: '🇮🇸', name: 'Iceland',                            code: 'IS', dial: '354',  digits: 7,  groups: [3,4]     }, // Small – 7 digits
  { flag: '🇮🇳', name: 'India',                              code: 'IN', dial: '91',   digits: 10, groups: [5,5]     }, // India specific
  { flag: '🇮🇩', name: 'Indonesia',                          code: 'ID', dial: '62',   digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇮🇷', name: 'Iran',                               code: 'IR', dial: '98',   digits: 10, groups: [3,3,4]   }, // Middle East
  { flag: '🇮🇶', name: 'Iraq',                               code: 'IQ', dial: '964',  digits: 10, groups: [3,3,4]   }, // Middle East
  { flag: '🇮🇪', name: 'Ireland',                            code: 'IE', dial: '353',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇮🇱', name: 'Israel',                             code: 'IL', dial: '972',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇮🇹', name: 'Italy',                              code: 'IT', dial: '39',   digits: 10, groups: [3,3,4]   }, // Europe – mobile 10 digits
  { flag: '🇨🇮', name: 'Ivory Coast',                        code: 'CI', dial: '225',  digits: 10, groups: [2,4,4]   }, // Africa – 10 digits
  { flag: '🇯🇲', name: 'Jamaica',                            code: 'JM', dial: '1876', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇯🇵', name: 'Japan',                              code: 'JP', dial: '81',   digits: 10, groups: [3,4,3]   }, // Asia – mobile 10 digits
  { flag: '🇯🇴', name: 'Jordan',                             code: 'JO', dial: '962',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇰🇿', name: 'Kazakhstan',                         code: 'KZ', dial: '7',    digits: 10, groups: [3,3,4]   }, // Central Asia (same plan as Russia)
  { flag: '🇰🇪', name: 'Kenya',                              code: 'KE', dial: '254',  digits: 9,  groups: [3,3,3]   }, // Kenya specific
  { flag: '🇰🇮', name: 'Kiribati',                           code: 'KI', dial: '686',  digits: 8,  groups: [4,4]     }, // Small island – 8 digits
  { flag: '🇽🇰', name: 'Kosovo',                             code: 'XK', dial: '383',  digits: 8,  groups: [2,3,3]   }, // Europe – 8 digits
  { flag: '🇰🇼', name: 'Kuwait',                             code: 'KW', dial: '965',  digits: 8,  groups: [4,4]     }, // Middle East – 8 digits
  { flag: '🇰🇬', name: 'Kyrgyzstan',                         code: 'KG', dial: '996',  digits: 9,  groups: [3,3,3]   }, // Central Asia
  { flag: '🇱🇦', name: 'Laos',                               code: 'LA', dial: '856',  digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇱🇻', name: 'Latvia',                             code: 'LV', dial: '371',  digits: 8,  groups: [2,3,3]   }, // Europe – 8 digits
  { flag: '🇱🇧', name: 'Lebanon',                            code: 'LB', dial: '961',  digits: 8,  groups: [2,3,3]   }, // Middle East – 8 digits
  { flag: '🇱🇸', name: 'Lesotho',                            code: 'LS', dial: '266',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇱🇷', name: 'Liberia',                            code: 'LR', dial: '231',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇱🇾', name: 'Libya',                              code: 'LY', dial: '218',  digits: 9,  groups: [2,3,4]   }, // Africa/Middle East
  { flag: '🇱🇮', name: 'Liechtenstein',                      code: 'LI', dial: '423',  digits: 7,  groups: [3,4]     }, // Small island – 7 digits
  { flag: '🇱🇹', name: 'Lithuania',                          code: 'LT', dial: '370',  digits: 8,  groups: [3,2,3]   }, // Europe – 8 digits
  { flag: '🇱🇺', name: 'Luxembourg',                         code: 'LU', dial: '352',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇲🇴', name: 'Macau',                              code: 'MO', dial: '853',  digits: 8,  groups: [4,4]     }, // Asia – 8 digits
  { flag: '🇲🇬', name: 'Madagascar',                         code: 'MG', dial: '261',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇲🇼', name: 'Malawi',                             code: 'MW', dial: '265',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇲🇾', name: 'Malaysia',                           code: 'MY', dial: '60',   digits: 9,  groups: [2,3,4]   }, // Asia
  { flag: '🇲🇻', name: 'Maldives',                           code: 'MV', dial: '960',  digits: 7,  groups: [3,4]     }, // Small island – 7 digits
  { flag: '🇲🇱', name: 'Mali',                               code: 'ML', dial: '223',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇲🇹', name: 'Malta',                              code: 'MT', dial: '356',  digits: 8,  groups: [4,4]     }, // Small island – 8 digits
  { flag: '🇲🇭', name: 'Marshall Islands',                   code: 'MH', dial: '692',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇲🇶', name: 'Martinique',                         code: 'MQ', dial: '596',  digits: 9,  groups: [2,2,2,2,1] }, // Uses French format
  { flag: '🇲🇷', name: 'Mauritania',                         code: 'MR', dial: '222',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇲🇺', name: 'Mauritius',                          code: 'MU', dial: '230',  digits: 8,  groups: [4,4]     }, // Small island – 8 digits
  { flag: '🇾🇹', name: 'Mayotte',                            code: 'YT', dial: '262',  digits: 9,  groups: [2,2,2,2,1] }, // Uses French format
  { flag: '🇲🇽', name: 'Mexico',                             code: 'MX', dial: '52',   digits: 10, groups: [3,3,4]   }, // Latin America
  { flag: '🇫🇲', name: 'Micronesia',                         code: 'FM', dial: '691',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇲🇩', name: 'Moldova',                            code: 'MD', dial: '373',  digits: 8,  groups: [2,3,3]   }, // Eastern Europe – 8 digits
  { flag: '🇲🇨', name: 'Monaco',                             code: 'MC', dial: '377',  digits: 8,  groups: [2,2,2,2] }, // Small – 8 digits
  { flag: '🇲🇳', name: 'Mongolia',                           code: 'MN', dial: '976',  digits: 8,  groups: [4,4]     }, // Asia – 8 digits
  { flag: '🇲🇪', name: 'Montenegro',                         code: 'ME', dial: '382',  digits: 8,  groups: [2,3,3]   }, // Europe – 8 digits
  { flag: '🇲🇸', name: 'Montserrat',                         code: 'MS', dial: '1664', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇲🇦', name: 'Morocco',                            code: 'MA', dial: '212',  digits: 9,  groups: [2,3,4]   }, // Africa/Middle East
  { flag: '🇲🇿', name: 'Mozambique',                         code: 'MZ', dial: '258',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇲🇲', name: 'Myanmar',                            code: 'MM', dial: '95',   digits: 9,  groups: [2,3,4]   }, // Asia
  { flag: '🇳🇦', name: 'Namibia',                            code: 'NA', dial: '264',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇳🇷', name: 'Nauru',                              code: 'NR', dial: '674',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇳🇵', name: 'Nepal',                              code: 'NP', dial: '977',  digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇳🇱', name: 'Netherlands',                        code: 'NL', dial: '31',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇳🇨', name: 'New Caledonia',                      code: 'NC', dial: '687',  digits: 6,  groups: [3,3]     }, // Small island – 6 digits
  { flag: '🇳🇿', name: 'New Zealand',                        code: 'NZ', dial: '64',   digits: 9,  groups: [3,3,3]   }, // Asia/Pacific
  { flag: '🇳🇮', name: 'Nicaragua',                          code: 'NI', dial: '505',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇳🇪', name: 'Niger',                              code: 'NE', dial: '227',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇳🇬', name: 'Nigeria',                            code: 'NG', dial: '234',  digits: 10, groups: [3,3,4]   }, // Nigeria specific
  { flag: '🇳🇺', name: 'Niue',                               code: 'NU', dial: '683',  digits: 4,  groups: [4]       }, // Small island – 4 digits
  { flag: '🇳🇫', name: 'Norfolk Island',                     code: 'NF', dial: '672',  digits: 6,  groups: [3,3]     }, // Small island
  { flag: '🇰🇵', name: 'North Korea',                        code: 'KP', dial: '850',  digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇲🇰', name: 'North Macedonia',                    code: 'MK', dial: '389',  digits: 8,  groups: [2,3,3]   }, // Europe – 8 digits
  { flag: '🇲🇵', name: 'Northern Mariana Islands',           code: 'MP', dial: '1670', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇳🇴', name: 'Norway',                             code: 'NO', dial: '47',   digits: 8,  groups: [2,2,2,2] }, // Europe – 8 digits
  { flag: '🇴🇲', name: 'Oman',                               code: 'OM', dial: '968',  digits: 8,  groups: [4,4]     }, // Middle East – 8 digits
  { flag: '🇵🇰', name: 'Pakistan',                           code: 'PK', dial: '92',   digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇵🇼', name: 'Palau',                              code: 'PW', dial: '680',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇵🇸', name: 'Palestine',                          code: 'PS', dial: '970',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇵🇦', name: 'Panama',                             code: 'PA', dial: '507',  digits: 8,  groups: [4,4]     }, // Central America – 8 digits
  { flag: '🇵🇬', name: 'Papua New Guinea',                   code: 'PG', dial: '675',  digits: 8,  groups: [4,4]     }, // Small island – 8 digits
  { flag: '🇵🇾', name: 'Paraguay',                           code: 'PY', dial: '595',  digits: 9,  groups: [3,3,3]   }, // Latin America
  { flag: '🇵🇪', name: 'Peru',                               code: 'PE', dial: '51',   digits: 9,  groups: [3,3,3]   }, // Latin America
  { flag: '🇵🇭', name: 'Philippines',                        code: 'PH', dial: '63',   digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇵🇱', name: 'Poland',                             code: 'PL', dial: '48',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇵🇹', name: 'Portugal',                           code: 'PT', dial: '351',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇵🇷', name: 'Puerto Rico',                        code: 'PR', dial: '1787', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇶🇦', name: 'Qatar',                              code: 'QA', dial: '974',  digits: 8,  groups: [4,4]     }, // Middle East – 8 digits
  { flag: '🇷🇪', name: 'Réunion',                            code: 'RE', dial: '262',  digits: 9,  groups: [2,2,2,2,1] }, // Uses French format
  { flag: '🇷🇴', name: 'Romania',                            code: 'RO', dial: '40',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇷🇺', name: 'Russia',                             code: 'RU', dial: '7',    digits: 10, groups: [3,3,4]   }, // Europe/Asia
  { flag: '🇷🇼', name: 'Rwanda',                             code: 'RW', dial: '250',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇼🇸', name: 'Samoa',                              code: 'WS', dial: '685',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇸🇲', name: 'San Marino',                         code: 'SM', dial: '378',  digits: 10, groups: [3,3,4]   }, // Uses Italian format
  { flag: '🇸🇹', name: 'São Tomé & Príncipe',                code: 'ST', dial: '239',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇸🇦', name: 'Saudi Arabia',                       code: 'SA', dial: '966',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇸🇳', name: 'Senegal',                            code: 'SN', dial: '221',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇷🇸', name: 'Serbia',                             code: 'RS', dial: '381',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇸🇨', name: 'Seychelles',                         code: 'SC', dial: '248',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇸🇱', name: 'Sierra Leone',                       code: 'SL', dial: '232',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇸🇬', name: 'Singapore',                          code: 'SG', dial: '65',   digits: 8,  groups: [4,4]     }, // Asia – 8 digits
  { flag: '🇸🇽', name: 'Sint Maarten',                       code: 'SX', dial: '1721', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇸🇰', name: 'Slovakia',                           code: 'SK', dial: '421',  digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇸🇮', name: 'Slovenia',                           code: 'SI', dial: '386',  digits: 8,  groups: [2,3,3]   }, // Europe – 8 digits
  { flag: '🇸🇧', name: 'Solomon Islands',                    code: 'SB', dial: '677',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇸🇴', name: 'Somalia',                            code: 'SO', dial: '252',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇿🇦', name: 'South Africa',                       code: 'ZA', dial: '27',   digits: 9,  groups: [2,3,4]   }, // South Africa specific
  { flag: '🇰🇷', name: 'South Korea',                        code: 'KR', dial: '82',   digits: 10, groups: [3,4,3]   }, // Asia – mobile 10 digits
  { flag: '🇸🇸', name: 'South Sudan',                        code: 'SS', dial: '211',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇪🇸', name: 'Spain',                              code: 'ES', dial: '34',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇱🇰', name: 'Sri Lanka',                          code: 'LK', dial: '94',   digits: 9,  groups: [2,3,4]   }, // Asia
  { flag: '🇰🇳', name: 'St. Kitts & Nevis',                  code: 'KN', dial: '1869', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇱🇨', name: 'St. Lucia',                          code: 'LC', dial: '1758', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇻🇨', name: 'St. Vincent & the Grenadines',       code: 'VC', dial: '1784', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇸🇩', name: 'Sudan',                              code: 'SD', dial: '249',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇸🇷', name: 'Suriname',                           code: 'SR', dial: '597',  digits: 7,  groups: [3,4]     }, // Small island/South America
  { flag: '🇸🇪', name: 'Sweden',                             code: 'SE', dial: '46',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇨🇭', name: 'Switzerland',                        code: 'CH', dial: '41',   digits: 9,  groups: [3,3,3]   }, // Europe
  { flag: '🇸🇾', name: 'Syria',                              code: 'SY', dial: '963',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇹🇼', name: 'Taiwan',                             code: 'TW', dial: '886',  digits: 9,  groups: [3,3,3]   }, // Asia
  { flag: '🇹🇯', name: 'Tajikistan',                         code: 'TJ', dial: '992',  digits: 9,  groups: [3,3,3]   }, // Central Asia
  { flag: '🇹🇿', name: 'Tanzania',                           code: 'TZ', dial: '255',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇹🇭', name: 'Thailand',                           code: 'TH', dial: '66',   digits: 9,  groups: [2,3,4]   }, // Asia
  { flag: '🇹🇱', name: 'Timor-Leste',                        code: 'TL', dial: '670',  digits: 8,  groups: [4,4]     }, // Asia – 8 digits
  { flag: '🇹🇬', name: 'Togo',                               code: 'TG', dial: '228',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇹🇰', name: 'Tokelau',                            code: 'TK', dial: '690',  digits: 4,  groups: [4]       }, // Small island – 4 digits
  { flag: '🇹🇴', name: 'Tonga',                              code: 'TO', dial: '676',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇹🇹', name: 'Trinidad & Tobago',                  code: 'TT', dial: '1868', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇹🇳', name: 'Tunisia',                            code: 'TN', dial: '216',  digits: 8,  groups: [2,3,3]   }, // Africa – 8 digits
  { flag: '🇹🇷', name: 'Turkey',                             code: 'TR', dial: '90',   digits: 10, groups: [3,3,4]   }, // Europe/Middle East – 10 digits
  { flag: '🇹🇲', name: 'Turkmenistan',                       code: 'TM', dial: '993',  digits: 8,  groups: [2,3,3]   }, // Central Asia – 8 digits
  { flag: '🇹🇨', name: 'Turks & Caicos Islands',             code: 'TC', dial: '1649', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇹🇻', name: 'Tuvalu',                             code: 'TV', dial: '688',  digits: 6,  groups: [3,3]     }, // Small island – 6 digits
  { flag: '🇺🇬', name: 'Uganda',                             code: 'UG', dial: '256',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇺🇦', name: 'Ukraine',                            code: 'UA', dial: '380',  digits: 9,  groups: [3,3,3]   }, // Eastern Europe
  { flag: '🇦🇪', name: 'United Arab Emirates',               code: 'AE', dial: '971',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇬🇧', name: 'United Kingdom',                     code: 'GB', dial: '44',   digits: 10, groups: [4,3,3]   }, // UK specific
  { flag: '🇺🇸', name: 'United States',                      code: 'US', dial: '1',    digits: 10, groups: [3,3,4]   }, // US/Canada
  { flag: '🇺🇾', name: 'Uruguay',                            code: 'UY', dial: '598',  digits: 9,  groups: [3,3,3]   }, // Latin America
  { flag: '🇻🇮', name: 'US Virgin Islands',                  code: 'VI', dial: '1340', digits: 10, groups: [3,3,4]   }, // Caribbean/NPA
  { flag: '🇺🇿', name: 'Uzbekistan',                         code: 'UZ', dial: '998',  digits: 9,  groups: [2,3,4]   }, // Central Asia
  { flag: '🇻🇺', name: 'Vanuatu',                            code: 'VU', dial: '678',  digits: 7,  groups: [3,4]     }, // Small island
  { flag: '🇻🇦', name: 'Vatican City',                       code: 'VA', dial: '39',   digits: 10, groups: [3,3,4]   }, // Uses Italian format
  { flag: '🇻🇪', name: 'Venezuela',                          code: 'VE', dial: '58',   digits: 10, groups: [3,3,4]   }, // Latin America
  { flag: '🇻🇳', name: 'Vietnam',                            code: 'VN', dial: '84',   digits: 10, groups: [3,3,4]   }, // Asia
  { flag: '🇼🇫', name: 'Wallis & Futuna',                    code: 'WF', dial: '681',  digits: 6,  groups: [3,3]     }, // Small island – 6 digits
  { flag: '🇾🇪', name: 'Yemen',                              code: 'YE', dial: '967',  digits: 9,  groups: [2,3,4]   }, // Middle East
  { flag: '🇿🇲', name: 'Zambia',                             code: 'ZM', dial: '260',  digits: 9,  groups: [3,3,3]   }, // Africa
  { flag: '🇿🇼', name: 'Zimbabwe',                           code: 'ZW', dial: '263',  digits: 9,  groups: [3,3,3]   }, // Africa
];

// Default selection
export const DEFAULT_COUNTRY = COUNTRIES.find((c) => c.code === 'ZA')!;

/** Format a raw digit string into spaced groups for a country */
export function formatPhoneNumber(digits: string, groups: number[]): string {
  let result = '';
  let pos = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const chunk = digits.slice(pos, pos + groups[gi]);
    if (!chunk) break;
    result += (gi > 0 && chunk ? ' ' : '') + chunk;
    pos += groups[gi];
  }
  return result;
}
