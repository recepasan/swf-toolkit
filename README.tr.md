# swf-toolkit

[English](README.md) | **Türkçe**

[![npm](https://img.shields.io/npm/v/swf-toolkit.svg)](https://www.npmjs.com/package/swf-toolkit)
[![CI](https://github.com/recepasan/swf-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/recepasan/swf-toolkit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/swf-toolkit.svg)](LICENSE)

Adobe Flash SWF dosyalarını okumak, düzenlemek ve yeniden yazmak için saf TypeScript kütüphanesi ve CLI. Java ya da başka bir harici araç gerektirmez.

- **SWF:** FWS, CWS (zlib) ve ZWS (LZMA) formatlarını okur ve yazar. LZMA kodlayıcı ve çözücü pakete dahil. Değiştirilmeyen dosyalar byte byte aynı yazılır.
- **AS3 decompiler:** Okunabilir ActionScript 3 kaynağı üretir. if/else, döngüler, for-in/for-each, switch, try/catch ve `&&`/`||`/ternary yapılarını geri kurar.
- **AS3 derleyici:** Düzenlenmiş ya da yeni yazılmış `.as` dosyalarını AVM2 bytecode'a derler. Var olan sınıflara yeni metod ve alan eklenebilir, yeni sınıf ve interface tanımlanabilir, sıfırdan SWF üretilebilir.
- **AVM2 P-code:** Bytecode seviyesinde düzenleme için disassembler ve assembler. Sabit havuzlarını, stack ve scope hesaplarını otomatik yapar.
- **AS1/AS2 (AVM1):** DoAction/DoInitAction blokları için disassembler ve assembler.
- **Kaynaklar:** Görsel (PNG/JPEG/GIF), ses (MP3/WAV), binary veri ve metin alanlarını dışa aktarır ve değiştirir.

Node.js 18+ gerekir. Paket hem ESM (`import`) hem CommonJS (`require()`) olarak gelir. Çalışma zamanında bağımlılığı yoktur.

## Kurulum

```bash
npm install swf-toolkit        # kütüphane olarak
npm install -g swf-toolkit     # CLI olarak (swf-toolkit komutu)
npx swf-toolkit info oyun.swf  # kurmadan çalıştırmak için
```

## CLI

```bash
# İnceleme
swf-toolkit info oyun.swf
swf-toolkit classes oyun.swf
swf-toolkit decompile oyun.swf com.foo.Bar
swf-toolkit disasm oyun.swf com.foo.Bar init

# AS3 kaynak seviyesinde düzenleme
swf-toolkit export-as3 oyun.swf ./src           # her sınıf için .as dosyası
#   … ./src altındaki dosyaları düzenle, yeni .as dosyaları ekle …
swf-toolkit import-as3 oyun.swf ./src out.swf   # sadece değişen üyeler derlenir
swf-toolkit compile oyun.swf out.swf Yeni.as Diger.as

# Sıfırdan SWF
swf-toolkit build app.swf Main.as lib/Helper.as --main Main --width 800 --height 600

# Bytecode (P-code) seviyesinde düzenleme
swf-toolkit export-pcode oyun.swf ./pcode
swf-toolkit import-pcode oyun.swf ./pcode out.swf

# AS1/AS2
swf-toolkit export-as2 eski.swf ./as2
swf-toolkit import-as2 eski.swf ./as2 out.swf

# Kaynaklar
swf-toolkit export-assets oyun.swf ./assets            # images, sounds, binary, texts
swf-toolkit replace oyun.swf out.swf 12 yeni.png 40 muzik.mp3

# Sıkıştırma
swf-toolkit decompress oyun.swf acik.swf
swf-toolkit compress acik.swf kucuk.swf lzma
```

`import-as3` her sınıfı mevcut bytecode'un decompile edilmiş haliyle karşılaştırır. Metni değişmeyen metodlar orijinal bytecode'larıyla kalır. Böylece decompiler'ın kusursuz geri kuramadığı kod, dokunulmadığı sürece bozulmaz. Decompile edilemeyen metodlar `// Decompilation failed` yorumu ve P-code ile yazılır. Bu metodlar elle yeni bir gövde yazılmadıkça hiçbir zaman boş gövdeyle değiştirilmez.

## Kütüphane

```ts
import { Swf, decompileClass, compileClassSource, compileSources, createSwf } from 'swf-toolkit';

const swf = await Swf.load('oyun.swf');
const abc = swf.abcTags[0].abc;

// Bir sınıfı AS3 olarak düzenle
const ci = abc.findClass('com.foo.Bar');
const src = decompileClass(abc, ci);
const edited = src.replace('return 10;', 'return 99;');
compileClassSource(abc, edited);              // sadece değişen üyeler derlenir
await swf.save('oyun-patched.swf');

// Sıfırdan SWF
const { abc: fresh } = compileSources([{ name: 'Main.as', text: mainSource }]);
await createSwf(fresh, { documentClass: 'Main' }).save('app.swf');
```

Diğer API'ler:

- P-code: `disassembleMethod`, `assembleMethod`, `exportPcode`, `importPcode`.
- Bytecode araçları: `decodeCode`, `encodeCode`, `computeLimits`, `verifyCode`.
- Parser: `parseAs3`.
- Kaynaklar: `exportAssets`, `replaceAsset`.
- AVM1: `decodeActions`, `formatActions`, `parseActions`, `encodeActions`.

## Derleyicinin isim çözümleme modeli

Yerel değişkenler ve parametreler register'lara bağlanır. Closure'ların yakaladığı değişkenler activation nesnesindeki slotlara konur. Diğer bütün isimler, sınıfın açık namespace kümesiyle bir `Multiname` olarak üretilir ve VM tarafından scope zinciri üzerinden çözülür. Flex derleyicisi de önceden bağlayamadığı isimler için aynısını yapar. Tip açıklamaları (`var x:Foo`, parametreler, dönüş tipleri) import'lar, aynı paket, top-level sınıflar ve SWF'in kendi sabit havuzu kullanılarak QName'e çözülür. Bu sayede `playerglobal.swc` gerekmez.

Kurucusu olmayan sınıflarda, sabit olmayan alan başlangıç değerleri için örtük bir kurucu üretilir. Bu değerler, Flex'te olduğu gibi `super()` çağrısından önce atanır.

Desteklenen dil özellikleri: sınıflar, interface'ler, kalıtım, `super`, getter/setter, static üyeler, const, varsayılan ve `...rest` parametreleri, closure'lar, bütün döngü türleri (etiketli break/continue dahil), switch, try/catch/finally, `with`, regex, Vector, nesne ve dizi literal'leri, `as`/`is`/`instanceof`/`in`/`typeof`/`delete`, bileşik atamalar (`&&=` ve `||=` dahil), E4X erişimleri (`.@attr`, `..child`, `.(filtre)`) ve XML literal'leri (çalışma zamanında `new XML(...)` olarak).

## Testler

```bash
npm test
```

Testler Node'un yerleşik `node:test` modülüyle yazıldı. Kapsadıkları:

- LZMA, SWF container ve ABC round-trip'leri, P-code round-trip'i ve doğrulayıcı.
- Parser, derleyici ve decompile → derle → decompile kararlılığı.
- PNG, ses ve AVM1 round-trip'leri.

[Ruffle](https://ruffle.rs) kuruluysa (`/Applications/Ruffle.app` ya da `RUFFLE=/yol/ruffle`) derlenen test programı gerçek bir Flash VM'de çalıştırılır ve 59 çalışma zamanı kontrolü doğrulanır. Ruffle yoksa bu test atlanır.

## Sınırlamalar

- **Derleyici tip denetimi yapmaz.** Tip hataları ancak çalışma zamanında ortaya çıkar. Arayüz uyumu ve override imzaları da denetlenmez.
- **finally:** `finally` blokları normal çıkış, `return`, `break` ve `continue` yollarına kopyalanır.
- **Namespace bildirimi:** Paket seviyesinde namespace bildirimleri (`public namespace x = "..."`) derlenmez. Var olan namespace'ler `use namespace` ve `ns::isim` ile kullanılabilir.
- **XML literal'leri:** `{ifade}` gömme desteklenmez.
- **Decompiler:** Flex/ASC çıktısında iyi sonuç verir. Obfuscate edilmiş kodda başarısız olan metodlar P-code olarak yorum satırında gösterilir.
- **Kaynaklar:** Fontlar ve shape/sprite vektör çizimleri dönüştürülmez, ham tag olarak korunur. JPEG3/4 alfa kanalı ayrı bir maske PNG'si olarak dışa aktarılır. Nellymoser ve Speex sesleri ham veri olarak çıkarılır.

## Lisans

MIT
