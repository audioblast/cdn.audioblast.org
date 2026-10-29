/**
 * prepaint.js — Activate the correct .page element from URL params before
 * the main app module parses. Avoids a flash of the home page when the user
 * deep-links to detail/taxon/etc. Kept tiny + plain ES5-ish so it can ship as
 * a normal <script> (not type=module) and execute synchronously.
 */
(function () {
  var p = new URLSearchParams(location.search);
  var onRecord = /\/r\/[^/]+\/?(index\.html)?$/.test(location.pathname);
  var onTaxon = /\/t\/[^/]+\/?(index\.html)?$/.test(location.pathname);
  var page = p.get('id')                        ? 'detail'
           : onRecord                           ? 'detail'
           : onTaxon                            ? 'taxon'
           : p.get('taxon')                     ? 'taxon'
           : p.get('page') === 'browse'         ? 'browse'
           : p.get('page') === 'traits'         ? 'traits'
           : p.get('page') === 'annotations'    ? 'annotations'
           : p.get('page') === 'about'          ? 'about'
           : p.get('page') === 'map'            ? 'map'
           :                                      'home';
  var el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
})();
