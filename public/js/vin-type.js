// Map what NHTSA's VIN decoder returns to the site's vehicle types
// (sedan, mid-suv, full-suv, mini-van, pickup, cargo-van, passenger-van, other).
// Shared by the calculator, checkout, the admin wizard and the server's /api/vin route.
(function (root) {
  var FULL_SIZE_MODELS = /\b(tahoe|suburban|yukon|expedition|sequoia|escalade|navigator|armada|wagoneer|land cruiser|lx ?\d{3}|qx80|gls|x7|g-?class|range rover(?! evoque| velar| sport)|hummer)\b/i;
  var TYPE_LABELS = { 'sedan': 'Sedan / Compact SUV', 'mid-suv': 'Mid-size SUV', 'full-suv': 'Full-size SUV', 'mini-van': 'Mini Van', 'pickup': 'Pick-up Truck', 'cargo-van': 'Cargo Van', 'passenger-van': 'Passenger Van', 'other': 'Other' };

  // GVWR text like "Class 2E: 6,001 - 7,000 lb" → 6001 (lower bound in lb), or null
  function gvwrLowerLbs(s) {
    var m = String(s || '').replace(/,/g, '').match(/(\d{3,5})\s*-\s*(\d{3,5})\s*lb/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function vehicleTypeFromVin(r) {
    r = r || {};
    var body = String(r.BodyClass || '').toLowerCase();
    var vtype = String(r.VehicleType || '').toLowerCase();
    var model = String(r.Model || '') + ' ' + String(r.Series || '');
    var lbs = gvwrLowerLbs(r.GVWR);

    if (/motorcycle|trailer|bus|incomplete|low speed|off-road/.test(vtype) || /motorcycle|trailer|bus|incomplete/.test(body)) return 'other';
    if (/pickup/.test(body)) return 'pickup';
    if (/minivan/.test(body)) return 'mini-van';
    if (/van/.test(body)) {
      if (/passenger|\bbus\b/.test(body) || (vtype.indexOf('multipurpose') >= 0 && !/cargo/.test(body))) return 'passenger-van';
      return 'cargo-van';
    }
    if (/sport utility|suv|multipurpose|crossover|mpv/.test(body) || vtype.indexOf('multipurpose') >= 0) {
      if (FULL_SIZE_MODELS.test(model)) return 'full-suv';
      if (lbs != null && lbs >= 6001) return 'full-suv';
      if (lbs != null && lbs >= 5001) return 'mid-suv';
      if (lbs != null) return 'sedan';                 // compact crossover (CR-V, RAV4, Equinox)
      return 'mid-suv';                                // unknown weight: middle of the road
    }
    if (/sedan|coupe|hatchback|convertible|wagon|roadster|liftback|saloon|cabriolet/.test(body)) return 'sedan';
    if (vtype.indexOf('passenger car') >= 0) return 'sedan';
    if (vtype.indexOf('truck') >= 0) return lbs != null && lbs >= 6001 ? 'pickup' : 'pickup';
    return null;                                       // let the form keep whatever is selected
  }

  var api = { vehicleTypeFromVin: vehicleTypeFromVin, gvwrLowerLbs: gvwrLowerLbs, TYPE_LABELS: TYPE_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.vehicleTypeFromVin = vehicleTypeFromVin; root.VIN_TYPE_LABELS = TYPE_LABELS; }
})(typeof window !== 'undefined' ? window : this);
