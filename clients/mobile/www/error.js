// The page the app shows when the website cannot load (no connection, the
// server down). In the phone's language; "Try again" reloads the app's site.
(function () {
  var T = {
    en: ["Can't reach zvena", "Check your internet connection and try again.", "Try again"],
    zh: ["无法连接 zvena", "请检查网络连接，然后重试。", "重试"],
    hi: ["zvena तक नहीं पहुँच पा रहे", "अपना इंटरनेट कनेक्शन जाँचें और फिर से कोशिश करें।", "फिर से कोशिश करें"],
    es: ["No se puede conectar con zvena", "Comprueba tu conexión a internet y vuelve a intentarlo.", "Reintentar"],
    ar: ["تعذّر الوصول إلى zvena", "تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى.", "إعادة المحاولة"],
    fr: ["Impossible de joindre zvena", "Vérifiez votre connexion internet, puis réessayez.", "Réessayer"],
    bn: ["zvena-তে পৌঁছানো যাচ্ছে না", "আপনার ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।", "আবার চেষ্টা করুন"],
    pt: ["Não foi possível acessar o zvena", "Verifique sua conexão com a internet e tente novamente.", "Tentar novamente"],
    ru: ["Не удаётся открыть zvena", "Проверьте подключение к интернету и попробуйте ещё раз.", "Повторить"],
    id: ["Tidak dapat menjangkau zvena", "Periksa koneksi internet Anda, lalu coba lagi.", "Coba lagi"],
  };
  var lang = String(navigator.language || "en").toLowerCase().split("-")[0];
  var t = T[lang] || T.en;
  document.documentElement.lang = T[lang] ? lang : "en";
  if (lang === "ar") document.documentElement.dir = "rtl";
  document.getElementById("title").textContent = t[0];
  document.getElementById("body").textContent = t[1];
  var retry = document.getElementById("retry");
  retry.textContent = t[2];
  retry.addEventListener("click", function () {
    location.replace(window.ZVENA_APP_URL || "https://zvena.app/");
  });
})();
