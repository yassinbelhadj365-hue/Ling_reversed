# Builds data/fr-en.tsv (the offline French -> English word list, js/dictionary.js) from
# kaikki.org's JSONL extract of English Wiktionary. See data/README.md.
param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public static class DictBuild {
  static readonly HashSet<string> Weak = new HashSet<string> { "obsolete", "archaic", "rare", "dated", "historical", "nonstandard", "misspelling" };
  static readonly HashSet<string> SkipPos = new HashSet<string> { "prefix", "suffix", "infix", "interfix", "symbol", "character", "punct", "phrase", "proverb" };
  static readonly HashSet<string> FuncPos = new HashSet<string> { "prep", "article", "det", "pron", "conj", "particle", "contraction", "adv", "intj" };
  static readonly HashSet<string> SkipFormTags = new HashSet<string> { "table-tags", "inflection-template", "multiword-construction", "romanization", "class" };

  static string Norm(string s) {
    return s.Normalize(NormalizationForm.FormC).Replace((char)0x2019, (char)0x27).Replace((char)0x2018, (char)0x27).Replace((char)0x2010, '-').ToLowerInvariant();
  }
  static string Clean(string g) {
    g = g.Replace('\t', ' ').Replace('|', '/').Replace('\n', ' ').Trim().TrimEnd('.');
    if (g.Length > 60) {
      int cut = g.LastIndexOf(' ', 57);
      g = g.Substring(0, cut > 20 ? cut : 57) + (char)0x2026;
    }
    return g;
  }
  static IEnumerable<string> Strings(object o) {
    var list = o as ArrayList;
    if (list == null) yield break;
    foreach (var x in list) if (x is string) yield return (string)x;
  }
  static void Add(Dictionary<string, List<string>> d, string k, string v, int max) {
    List<string> l;
    if (!d.TryGetValue(k, out l)) { l = new List<string>(); d[k] = l; }
    if (l.Count < max && !l.Contains(v)) l.Add(v);
  }

  public static string Run(string inPath, string outPath) {
    var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1000 };
    var own = new Dictionary<string, List<string>>(StringComparer.Ordinal);   // word -> its own meanings
    var func = new HashSet<string>(StringComparer.Ordinal); // grammar words: their own meaning comes first
    var names = new Dictionary<string, List<string>>(StringComparer.Ordinal); // proper names, used only if nothing else
    var refs = new Dictionary<string, List<string>>(StringComparer.Ordinal);  // form -> the dictionary words it comes from
    int lines = 0;
    foreach (var line in File.ReadLines(inPath, Encoding.UTF8)) {
      lines++;
      Dictionary<string, object> e;
      try { e = ser.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
      object wo, po;
      if (!e.TryGetValue("word", out wo) || !e.TryGetValue("pos", out po)) continue;
      string word = (string)wo, pos = (string)po;
      if (word.Contains(" ") || SkipPos.Contains(pos)) continue;
      string token = Norm(word);
      bool isName = pos == "name";
      var strong = new List<string>();
      var weak = new List<string>();
      object so;
      if (e.TryGetValue("senses", out so) && so is ArrayList) {
        foreach (var sObj in (ArrayList)so) {
          var s = sObj as Dictionary<string, object>;
          if (s == null) continue;
          object fo;
          var tags = new HashSet<string>(s.ContainsKey("tags") ? Strings(s["tags"]) : Enumerable.Empty<string>());
          if ((s.TryGetValue("form_of", out fo) || s.TryGetValue("alt_of", out fo)) && fo is ArrayList && ((ArrayList)fo).Count > 0) {
            foreach (var f in (ArrayList)fo) {
              var fd = f as Dictionary<string, object>;
              object fw;
              if (fd != null && fd.TryGetValue("word", out fw) && fw is string && !((string)fw).Contains(" ")) {
                string lemma = Norm((string)fw);
                if (lemma != token) Add(refs, token, lemma, 3);
              }
            }
            continue;
          }
          if (tags.Contains("form-of") || tags.Contains("alt-of")) continue;
          var gl = s.ContainsKey("glosses") ? Strings(s["glosses"]).ToList() : new List<string>();
          if (gl.Count == 0) continue;
          string g = Clean(gl[gl.Count - 1]);
          if (g.Length == 0) continue;
          (tags.Overlaps(Weak) ? weak : strong).Add(g);
        }
      }
      var chosen = strong.Count > 0 ? strong.Take(2).ToList() : weak.Take(1).ToList();
      foreach (var g in chosen) Add(isName ? names : own, token, g, 3);
      if (chosen.Count > 0 && FuncPos.Contains(pos)) func.Add(token);
      // A dictionary word lists its own forms (conjugations, plurals, feminine...).
      object fso;
      if (chosen.Count > 0 && !isName && e.TryGetValue("forms", out fso) && fso is ArrayList) {
        foreach (var fObj in (ArrayList)fso) {
          var f = fObj as Dictionary<string, object>;
          object ff;
          if (f == null || !f.TryGetValue("form", out ff) || !(ff is string)) continue;
          string form = (string)ff;
          if (form.Contains(" ") || form.Length == 0) continue;
          var ftags = f.ContainsKey("tags") ? Strings(f["tags"]) : Enumerable.Empty<string>();
          if (ftags.Any(t => SkipFormTags.Contains(t))) continue;
          string ft = Norm(form);
          if (ft != token) Add(refs, ft, token, 3);
        }
      }
    }
    foreach (var kv in names) if (!own.ContainsKey(kv.Key) && !refs.ContainsKey(kv.Key)) own[kv.Key] = kv.Value;
    var keys = new HashSet<string>(own.Keys, StringComparer.Ordinal);
    foreach (var k in refs.Keys) if (refs[k].Any(l => own.ContainsKey(l))) keys.Add(k);
    var sorted = keys.ToList();
    sorted.Sort(StringComparer.Ordinal);
    var sb = new StringBuilder();
    foreach (var k in sorted) {
      var items = new List<string>();
      List<string> r, o;
      own.TryGetValue(k, out o);
      if (o != null && func.Contains(k)) { items.AddRange(o); o = null; }
      if (refs.TryGetValue(k, out r)) foreach (var l in r) if (own.ContainsKey(l) && items.Count < 2) items.Add("@" + l);
      if (o != null) items.AddRange(o);
      sb.Append(k).Append('\t').Append(string.Join("|", items)).Append('\n');
    }
    File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));
    return string.Format("lines={0} own={1} refs={2} written={3}", lines, own.Count, refs.Count, sorted.Count);
  }
}
'@
[DictBuild]::Run($In, $Out)
