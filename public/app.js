async function downloadVideo(){

  const url = document.getElementById("url").value;
  const quality = document.getElementById("quality").value;
  const status = document.getElementById("status");
  const button = document.querySelector(".download-main-btn");

  if(!url){
    status.innerHTML = "Cole uma URL válida.";
    return;
  }

  button.innerHTML = "Convertendo...";
  button.disabled = true;

  status.innerHTML = `
    ⏳ Baixando vídeo...<br><br>
    Isso pode levar alguns minutos dependendo do tamanho.
  `;

  try{

    const req = await fetch("/api/download",{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        url,
        quality
      })
    });

    const data = await req.json();

    if(data.download){

      status.innerHTML = `
        ✅ Conversão concluída.<br><br>

        <a href="${data.download}" download>
          Clique aqui para baixar o vídeo
        </a>
      `;

    }else{

      status.innerHTML = `
        ❌ Falha ao converter vídeo.
      `;

    }

  }catch(err){

    status.innerHTML = `
      ❌ ${err.message}
    `;

  }

  button.innerHTML = "⬇ Baixar Vídeo MP4";
  button.disabled = false;

}

document
  .getElementById("clear-history")
  .addEventListener("click",()=>{

    const downloadsContainer =
      document.getElementById("downloads");

    downloadsContainer.innerHTML = "";

    Object.keys(downloads).forEach(key=>{
      delete downloads[key];
    });

});
