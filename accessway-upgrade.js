// AccessWay upgrade: load AFTER script.js
(function () {

    // Stats strip under the hero
    const stats = document.createElement("div");
    stats.className = "stats-strip";
    stats.innerHTML = [
        ["Global", "place search"],
        ["3", "user profiles"],
        ["5", "facility checks"],
        ["1", "admin review step"]
    ].map(s => '<div class="stat"><strong>' + s[0] + "</strong><span>" + s[1] + "</span></div>").join("");
    document.getElementById("home").after(stats);

})();
