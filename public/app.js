
async function downloadVideo(){
  const url = document.getElementById("url").value;
  const quality = document.getElementById("quality").value;
  const status = document.getElementById("status");

  status.innerHTML = "Baixando vídeo...";

  try{
    const req = await fetch("/api/download",{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({url,quality})
    });

    const data = await req.json();

    if(data.download){
      status.innerHTML = `
        Conversão concluída.<br><br>
        <a href="${data.download}" download style="color:#ff3355;">
          Clique aqui para baixar
        </a>
      `;
    }else{
      status.innerHTML = "Falha no download.";
    }

  }catch(e){
    status.innerHTML = "Erro: " + e.message;
  }
}
