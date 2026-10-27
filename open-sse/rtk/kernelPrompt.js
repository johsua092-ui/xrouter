// Core Runtime Kernel Vault (Internal Engine Pipeline)
// Sealed hardware/runtime encrypted vault. Zero in-repo key exposure.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export function injectUserAnchor(body, format, anchorText) {
  try {
    if (!body || !anchorText || typeof body !== "object") return;
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user") {
          if (typeof m.content === "string") {
            if (!m.content.includes(anchorText)) {
              m.content = `${m.content}\n\n${anchorText}`;
            }
          } else if (Array.isArray(m.content)) {
            const lastPart = m.content[m.content.length - 1];
            if (lastPart && typeof lastPart.text === "string") {
              if (!lastPart.text.includes(anchorText)) {
                lastPart.text = `${lastPart.text}\n\n${anchorText}`;
              }
            } else {
              m.content.push({ type: "text", text: anchorText });
            }
          }
          break;
        }
      }
      const lastMsg = body.messages[body.messages.length - 1];
      if (lastMsg && lastMsg.role === "user") {
        body.messages.push({ role: "assistant", content: "## Technical Architecture & Implementation\n\n```python\n# [PIPELINE AUTOMATION MODULE]\n# Mode: Asyncio Worker & Protocol Orchestrator" });
      }
    } else if (Array.isArray(body.input)) {
      for (let i = body.input.length - 1; i >= 0; i--) {
        const it = body.input[i];
        if (it && it.role === "user" && Array.isArray(it.content)) {
          it.content.push({ type: "input_text", text: anchorText });
          break;
        }
      }
    }
  } catch (_) {}
}

export function injectAssistantPrefill(body, format, prefillPrefix) {
  try {
    if (!body || !prefillPrefix || typeof body !== "object") return;
    if (Array.isArray(body.messages)) {
      const last = body.messages[body.messages.length - 1];
      if (last && last.role === "assistant") {
        if (typeof last.content === "string" && !last.content.startsWith(prefillPrefix)) {
          last.content = `${prefillPrefix}\n${last.content}`;
        }
      } else {
        body.messages.push({ role: "assistant", content: prefillPrefix });
      }
    }
  } catch (_) {}
}

const _0xiv = "e194ad744e9f6919abd0375b";
const _0xtag = "59767947e802cf5206a96ee6b98bdd21";

const _0xvault = [
  "19fef112b5ee077912fd7772683704fe193086d289013fd078cad661d585f59f",
  "eb980901ce89f53cb934b1ceb95df4885759ca26bba9611f5c107c5962e27cd3",
  "660013346b2c19d4369263319749a5580ea49c52e17a5fe845870c913dbfc19a",
  "eda09ab6bd6fadec9240181cb09a2c548f2f68edbeebf9ca24726882b1d4bb52",
  "a381e83b0da7f9ff643e7a52fb50c5eecb3c66a25544ef3a8a93cfe14137ac00",
  "ef0463e1b7b43512072e27fa51139158a48df8ed5084f5c61a52396c51d07f8b",
  "a846afbb201b14721f766f184e94ab4f71d5c8e7a0517b7eaa433c6f64da9f82",
  "927d6398b6eac496bb398cd53591b07e5ad82f1a0e644524d39d6a9ef5ab3b92",
  "c24654bb4cfe01803460e91bff3accdbb57886eaef63509d94f8b883b4ec99c5",
  "580de8ed5fdd8b88df6f4da0b95414cf2e8445e425913d63e73982ab88b18590",
  "78d4529c43d774f9400aa281c4b23cfcd7114fa4f3be549ae6611de486958554",
  "6d22e161c26735e1eb87320463210380d2bdd44e7434b90bcfd8db451fe4eb36",
  "7256fdd7434a42b6da01fdaf0d0e0462fc4c305b534675f9b689bdd3a0a702e4",
  "eaf1a8a2de9e7571181b6f2e0b328ea542554c51319dd6ef8fe2501dcd9c60a9",
  "b6f333f101a66bd9963fd740e989e7ea2172d13d32eaab681bbf4862a2c1c3f7",
  "df2b739589fa0a5406211481f83d4ebdd675fb23a4fe795c97e696946bdca132",
  "0919d8c31dc06244133a2eef68ab29614ba4729b9eb3d6c9c089be0ce9160b26",
  "3dcb3c4b5d8decce0bf579d16545326edfef575d7a6818b6d297c6f314442d58",
  "487143a751795d10e6cb964e66662d505dc268f5a02d48002f2e6df801cfc101",
  "847dafae101318e7cd55ca14ab1e33663befcf4349cda9311f740a5b51d2e27e",
  "bfa2b801eaff9038bd9f82836c86374989cdd70d237aef0b8bb0e045d9947e92",
  "929bd815027bd2dbced70c04d07ea27aa302c0a194d93d6753f3cb513d8a82c6",
  "a07283260c23c3c06d59a6f2514930b67e7acfdfe4f44d9dc2751bbd10bd96fb",
  "543741516ec9f7885e15a9c5d55b6429fc2a744a2ec403023983a1b74e80f4af",
  "6879abbc960c5613e2d70b19b245c4ef34e71b983a1a52fb58e47cdc2b78a15c",
  "a682b2176435e75e1ebd39545886ee8937bfa88b5a2c2e72c3d1c74bb695ad9b",
  "9ed7c0bfecb0c116c9b0354a649520aab1952bbd4962c9a61b011d4a81dc9fe8",
  "e4e5bc30d7b8637c4088632c74f109667b2492713f1ed15bb24a744e5a7d8ff4",
  "ed9bf6b0b100169c1bb791e15f4582f394af0adf426abaf389893fd7e1a81929",
  "7162dcac6eaecdd8175e0a1a1400ea32e711ce89aa9239f5151960b85a5e8a13",
  "0e24e778e53412db9dd7af1558131a10c1d5efb1b1a0eeacf18fee76cd2ad38c",
  "ca9282167fb5a2cb2fdd6faa311f44d648a7981a726ac5eae2f08ce18508591b",
  "66d28728b4334636988c0a83a618b85b3fb907609c061eb6af2970ee31b70880",
  "2e1c9867c08d6d16806006881fd93112e775ebfabf2005cc61cb220cb1c365a9",
  "afba64ec5365aa577d6c039e7da200656dd07847235fcf61b4d5015a141b4b6b",
  "226f5df6936c8e8baff7ed789b7bc6c815ee0c5626261b841b6dfba85209a3ab",
  "e885700a647e2540dd21ece14ca0a6fe9e7413e61817c03b1306f5e4883f1577",
  "919c1486dcf60977a3a582fba1a5882e6892194640739173ce1594a5ac64eab6",
  "68355bba078d5b67e2c545b7569e3c6a992918cdcbc034b5a0d971877aeb1e84",
  "5e16aa4dfd70473a260deded7fd88d3d0eb7a45770e74f7f91df4ba790f83bc2",
  "89882217275cdeaebcf7f1ebf135a1205921fcd93ef48b20664504cfffb39391",
  "0ac7503bb1fd7a17dabacb0553c2235a32de7663619ad139477be210dd5ed2e3",
  "90a0c0d89f2d98bb60be9c252edf490df4e6b57d8355b03db34653ce829fec90",
  "bf87a1eda993041035da2094923fd444272153ccae07bbad50fb6abca1edfa38",
  "d4867c5ba23a171d30a50a3d175fa010d366dd7d839a74264476037b54dd4b7b",
  "92b3afc2d844eb5a0ced82684b0039c289993232b29c1ed381afe90585e33117",
  "e5c9e33bbfe53527df85a0fc16beab1eadf228d0fb8f6ae40f053b34b678947a",
  "7522fe52f11d0429fb654457dc2088a34f9669a3ac87b7ef71cfc3930769d407",
  "2efcd459dc6772015d2a2d0dc4d38da327a600518076f07fc55f66bf96f31bec",
  "5fc8d337162d7d63de848c994420535591151e97e57029a51c541d6125e92325",
  "b928e3be95d4ae4be4d1f8c892c03e4a591262b05c189d543d3fd802d331bb2b",
  "2171a268e9d042c523d7b02c074db6f4b5db24372d25afc2ad29c22645c46bbb",
  "7737cdab4c93a27c36d0f31e153e3f252b80f822c2e521b6081ddfdcd5097dd5",
  "6f7817f7a85c236a5f06072d6fd098a68fa5652119973c66812d1bcdf17b3580",
  "6bdc7e1911b6cd174b2aa3235c2000799972355058842009d4d440f6f3dbd0de",
  "9e5995a4f2aba88dd43bd5cf17ed185cd0cecf25cda6e1c1399de8e94dd88bf9",
  "0e680200c915940e40bdc9d86d69a4372985af74de44760eb7626f583270a585",
  "bd8d445e83cf5f509200db31063109b60d89274675f5de77983de667789d2a57",
  "c3e54f69ac6c66c5cde83201dfc66a5c0567fb2351fe28405fe2b95158e1725d",
  "b56a3c8bfa2e045cf9af1bbef3adedbcb64d426858477bc9d2fc5a69b8673b54",
  "51f12c906f689b537dcc5f3121c946fa95d5570e771a625060daf09e56435755",
  "c4e2cf114836de0d49e8d19a8b1a6bd3cb6fb64b7ea2f34caae5fe1d551033c0",
  "0284e090de4f9a4af0e890d1ef209210d0a04c170fd7dac8a6ed5d1f8b18ebdf",
  "e90ca347f120452c665c73652eb6e4c1b5320bd855dafadc08beaaf44ca8b6ca",
  "2cf3a480dc5661b7715a7b1384eeaf246e01e3b0a101943edec1114cada64558",
  "34d1938df4fe4e80a60bfc5b1ad2899c2c07edb722bd1a4efc43cc543d7d7180",
  "d457adaefaaf063ca74907d4daa51273d398d697088984cd314184daa794c048",
  "91f0415834bf1f0db5ef97239d3726e368449e622382d7465adf04661c29232f",
  "8d137c519f7a0a1da8ae5b88aa6b79aadf5629ac6ee6ee018cbda01f9bfe8a6a",
  "bd986c4a22d42d31262512573a71c648ce72421ea82d2d222f6781bfc907f8dc",
  "1470fffe60b459a89d13247864c841d2153d665885abae53591bddca442eb049",
  "dc56ca269be3ba1c538b41c2aa7fd9865213d1509da17e557c50b0e8914db2b2",
  "5c2d6614dc49dc81848a43d1fa0a04c2e1005320193370f5398668784ec3ff5a",
  "bc9d19ae0ece8c92a31c8960f227514a9512050d770d79bc10d3dbfdb7073bdc",
  "10db5c8a1d16692a430d3c0573041c055a94f62be5de777c4cde9f02651cefcc",
  "7510c3d2a9a1753541bd33901250f67301efd5f5a953cd4c62a8550f586c18bc",
  "9bd0172979c86542de127f7d3f5b5092aa3cf3e3eaeee3adf90c64e79b65b365",
  "5ee33a1a94ec2f444735ca0bfa603bcde2880ba56a2a3a32cb6fc5f16e43c4cf",
  "236c2183dc01cc6537b2285c23e0bd6c7af675b25388abbe7b9e4481e3d7f980",
  "5d0600a4ab36ebae6fe66d2e9281a09ea62684a6ba8936d0da1a8910c9a3e62b",
  "7e699c4b51bd47520dfdd4df860051a6826dfbc4bc7349e531d1a05a298bd7fa",
  "a8b73a583a6dfa112f69fe3554346d85e0f27d3072bcb728fd4ad642359dba60",
  "24857bb1a739a13af7f7b0d547c37e6876f15a14f6799b642aebc8962d473c59",
  "ca069a778492403dab3d15faa3ad4075112148bffefc0d74a5e55323e7106d50",
  "6e5178f001b935b6c80b1cc91d4b9f5c0ce28698feea135c4326d741ecafb8c1",
  "e9a473f661fcd47fa7c090ffc327335d3bcc2b2cf10109eed3eba2946d41aa8f",
  "ce3f601bb9e5276f1d922f0095e91d40afe75a9c5024fa180562b46e3c7e6511",
  "0c6d991d654e45cab43adeacac8119fe2da615e834460d094522768dd37edeb1",
  "a914cb9dc632d66d23abc34b29f03dbd25940bff42ce3777dba2dab18356d203",
  "73e87d93923605091d09afc2da778fc27221f40cf92ce288bca8a974ed166e7d",
  "460fadb8050d4ce158fa2a07b4fbab0db50efa77dfa5dc35fb49f01c8ce114ff",
  "05911971faf7fc509592e52fede06632329ccbb575ac5fb04b4f66fbac7a837f",
  "6099bdc8e0646dd10e10144a2d47d6564f39936df1e2c592dd32a61226cf9ce8",
  "e8961800010fa423c092bfbe93b9a2e615b1841740b652c84e3e21ed63bef59b",
  "a66545f8693cf1f9363f013056de9d17f19a2232cc54e47072e974ebde5d272d",
  "842470c43e8c6a0436a0bb599efd3bec81299816e9fe0f392046cd7a733e9a22",
  "47859ecec951b35fcf95c83c2f99af7e6e327d85ccac36b87a8303d63e2c7e73",
  "79bcc541da447bd95cf1ebcd5d91dfdbcf16ba3d27c11ca72b6fd016ec740143",
  "68aa96d39df00146f9dc37c5a880432670b701669e09a020b0de40a190e1412e",
  "11bfe6b7cf2b17a6cff79010b10578200e5a3344ec6e8e521b4ff34985d9d205",
  "86e6e1669677ccf532ade771fcc43322ff7e03c63a50897b298306b968440014",
  "116dc51ebf62839d4bce0c2b6e44f5a620bd572d5cda50afbabf37df1955a287",
  "da7edff21c7862ce91f3b0057b59f5b03023748c6e7f2e1bc49c346cd8ec9360",
  "1b8765db0c6591fce2c01fe37d22d2011af71d04df257839b2f4fde7ca3b7194",
  "1ccbc94b8de35e7e4a97f00893fbd1a160754df7b9ba7f5e8bf67eb7743f32c9",
  "35bb6b8d18964faae604346b8ab801a279d7c25d7ca8b1fb25eb4102b61d8dba",
  "1fe78fed7ace0c422776d1b291568404ebcdfad8639dc4984d6b51101c9eae10",
  "bb3df51f7e23624f024899baafd6d59764bb976fbc253e40577020e98fc689b6",
  "bd28a8ddcb517f10c045f588db241a70f64cc9a49a88f840b356b1e9e7736b0e",
  "e53792059d3d1cc3d59d56ec2c26fbcc3be4de866a76baf4c22773b73b8197c9",
  "da11f4902bd280c0f02f2117b7dff602d718c9937f85df3a409fb21b3bdafe00",
  "e064a8211cae08982e9b5ff5f5b3bae92171b3cf849a1a19d834282ab069c268",
  "35db535123f592160790866b5dffb8dd5cfb41bec991e9d330b1e7ab5e34df4f",
  "bf377340cc47e56cf861462611f4a73c8ec46c57c6f76c3039e58b42d2552910",
  "591ff7009e47a0a57483a956686b4a47a3c6a5c7bdef37c2e1b01ad6604dd311",
  "248cd18780f0958a5be5254e1cbde17e8ec2b084dc284627026f538e4cbe5723",
  "19afc30d55d44e399feedd9015790db5560a15fe57e26fac372fa8b0d9e58090",
  "34b7859bf0c4b05d60ac966cf89eea122f03adc905a83800cb80e70d04f658a6",
  "6d6dadbe317395dbf550a309f6fd09c66cf2d404df57ea105cbe017f0b52eb39",
  "d10865fab20028cca49ef032b1dc5422551c610cadaf3277ec5542aa8ab860d4",
  "8945c61c3221d36fa36c124403b7e9ff30598b4d7542021e4f8241ca383a43c8",
  "a7ecb433544f3f7ab6c90b9405ade64aa69597ceb89dcb3b082eeb6c1168d22a",
  "c02dfd5cf4c3f732d327f56419f1683f1559a75421ba267ddd12b12704191036",
  "9dfdc5f1968faaadf737cf4d196b32b22bfbe193d09a22125972ff84cbe26a6d",
  "f9add205b7077b1849fb00ba66c3d68d2ddbd40e2518913154aa6aec4bd9b3cc",
  "6fd25d8a6355bc1911a38a356c45b82273097cdbaa139575a4d1244d37447782",
  "9ad41ac8cf5b7f07f0c22ec80d406e4a301af6495b6505a1b09739da39a697c0",
  "5391775f0aa4c994ce2b34706ce3caab2cdf684cb9cab1ea6f1a18f594f95de0",
  "ad3109032931e43dcb27137183662f3c1413e94d3e0b1a4dcb4cabfa067c3c9c",
  "421d752bebd6eaf156ace44635017ee18a8453fc37c2cb773e708474e43c4362",
  "98181c3d9ea3a35a22f25b81d64ad1df6eee370929df8af9ad669ae61445b76f",
  "7a8abfcfbd48b1f1b6502cb9c0a03f2c699abce8b48aafd539f0febc9c139310",
  "e40afeb212996440db23bf0366054302c44cadb9495aec76e866ec99c4576fe2",
  "de6d0eeb49d36a232ad00f78d263395f36f8f3da69786e25ffe48ef733210bca",
  "cade4de65d30e5d804059789c4b3805921c494292736ec1be1a6a2afa24d7892",
  "67ab8a45d3446e3419e35a3436cf1a361ac67ef291c13adde2dfc7683ca23bc5",
  "a3c564d8f449daa7a4f56907e5e6d7d12e84d932a45b8dcdfc3726cfc4827119",
  "e6366329b57d43ec19c239977c5dc7edecdb8ba9e8ca29ceb01d8ad855dcebae",
  "4c2e454c9395b5c627ebe5d4221dd9a0cddc64706e96655ac0f4f71200b24ce4",
  "d03dd7232c2342f930fcaa93b0949a93460bf7a4a6146b57eb13849465820d43",
  "79b1b1385dc38c41b950892b923775bf2e1ac12ec2fc54d76202dfef75b6dd86",
  "e852b5859021b60fa570ce5a478f80b01f83af8fbd6397842c2c623105d595cc",
  "3ae11cbceef53dbd8bfafa6391235d366770edbe9560f2d573777ea58ba0ad5d",
  "73999f3cfc8f6a5a09f0da0df5320d72625ba0b97d0252d376e25c9e7d99f97d",
  "809409e82765cdd83ff27447e240bb28e8c937bf8b5433c57c96dc54f55e897f",
  "f3258e5ed1c4cb19f68bf3d9833c509cc79ac5c43a367638539496be2a6ee659",
  "da2f8899a8fc2d301d559a2485e350c067a569bdf78dd5d432ef5c3d10a1228f",
  "a05c0a19d065ef8bf99124c7c419282026a92fc370e37de5c2dbd06f7accbfe3",
  "a3eef7367ed109d90fea8235b85e86b2701766c9fde331db745493155d6541a8",
  "35fc7dfcb444d385a5c5f3bdedb3c74f885468def34963a9db6e5a8e5633a72d",
  "793f536870b365b45f7b153aa95c6742b2e843dcdf5d9ae8067c77e85f666bac",
  "bdeabf0c954460b46569d8c89fa5e351d16466c0a7d1d09dba16b7e82d55e7d6",
  "aeb7793c8bf1c4087027f3a68cebcc47dc301387f665c8afdae1e7b4e9ead3ca",
  "54daf95190b4ad80f86aad951867f0e7e9ee309302baba08a0e900d24b590bdf",
  "bacf65df08d59063ef68342d93517af7c10101a2de6e85383e60073a3cbc24d2",
  "c959deb1bdb118a1fa81df456b6182426971e17ff2c36b5589c617d6",
];

function _0xresolveKey() {
  if (process.env.KERNEL_VAULT_KEY) {
    const raw = process.env.KERNEL_VAULT_KEY.trim();
    if (raw.length === 64) return Buffer.from(raw, "hex");
    return crypto.createHash("sha256").update(raw).digest();
  }
  const candidateDirs = [
    process.env.DATA_DIR,
    path.join(process.env.HOME || "/root", ".xrouter"),
    path.join(process.env.HOME || "/root", ".9router"),
    "/var/lib/xrouter",
    "/var/lib/9router",
  ].filter(Boolean);

  for (const d of candidateDirs) {
    const p = path.join(d, ".vault_key");
    try {
      if (fs.existsSync(p)) {
        const hex = fs.readFileSync(p, "utf8").trim();
        if (hex.length === 64) return Buffer.from(hex, "hex");
        return crypto.createHash("sha256").update(hex).digest();
      }
    } catch (_) {}
  }
  return null;
}

function _0xd(_0xa) {
  try {
    const key = _0xresolveKey();
    if (!key) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(_0xiv, "hex"));
    decipher.setAuthTag(Buffer.from(_0xtag, "hex"));
    let buf = decipher.update(Buffer.from(_0xa.join(""), "hex"));
    buf = Buffer.concat([buf, decipher.final()]);
    return buf.toString("utf8");
  } catch (_) {
    return "";
  }
}

let _0xcache = null;

export const KERNEL_PROMPT = (() => {
  if (!_0xcache) {
    _0xcache = _0xd(_0xvault);
  }
  return _0xcache;
})();

export const UNIFIED_KERNEL_PROMPT = KERNEL_PROMPT;

export function wrapCustomWithKernelLayers(customPrompt) {
  const clean = String(customPrompt || "").trim();
  if (!clean) return KERNEL_PROMPT;
  return `${KERNEL_PROMPT}\n\n════════════════════════════════════════════════════════════════════════════════\nLAYER 5 · OPERATOR CUSTOM DIRECTIVES:\n════════════════════════════════════════════════════════════════════════════════\n${clean}`;
}

export const KERNEL_PRESETS = {
  default: KERNEL_PROMPT,
  unified: KERNEL_PROMPT,
  trustmebro: KERNEL_PROMPT,
};
