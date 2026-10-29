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
  // The named page, if the page has it. This runs before the site's config is
  // read, but a feature the site leaves out (config.features) isn't in its page,
  // so its address is taken as one with no page, as route() in app.js takes it.
  var named = /^(browse|traits|annotations|about|map)$/.test(p.get('page'))
           && document.getElementById('page-' + p.get('page')) ? p.get('page') : '';
  // In route()'s order. The traits and annotations pages are filtered by taxon,
  // so on those a taxon in the address is a filter, not a taxon to show.
  var filtered = named === 'traits' || named === 'annotations';
  var page = p.get('id')                        ? 'detail'
           : onRecord                           ? 'detail'
           : onTaxon && !filtered               ? 'taxon'
           : p.get('taxon') && !filtered        ? 'taxon'
           : named                              ? named
           :                                      'home';
  var el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
})();
