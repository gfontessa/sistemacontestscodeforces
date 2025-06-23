/**
 * @OnlyCurrentDoc
 * Sistema de Análise de Contests - Codeforces
 */

// --- CONFIGURAÇÕES GLOBAIS ---
const CONFIG = {};
const DB_CONTESTS_SHEET = 'DB_Contests';
const DB_PROBLEMS_SHEET = 'DB_Problems';
const DB_PARTICIPACOES_SHEET = 'DB_Participacoes';
const PERFORMANCE_SHEET = 'Contests Performance';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⭐ Análise de Contests - Codeforces')
    .addItem('🚀 Gerar Relatório Completo', 'atualizarAnaliseCompleta')
    .addSeparator()
    .addItem('⚙️ Criar/Zerar Aba de Configurações', 'criarAbaConfiguracoes')
    .addItem('🎲 Criar/Zerar Abas de Banco de Dados', 'criarAbasDeBancoDeDados')
    .addToUi();
}

// ===================================================================================
// ORQUESTRADOR PRINCIPAL
// ===================================================================================

function atualizarAnaliseCompleta() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  if (!carregarConfiguracoes()) return;
  
  ss.toast('FASE 1/2: Atualizando Banco de Dados...', 'Progresso', -1);
  atualizarBancoDeDados();
  
  ss.toast('FASE 2/2: Gerando o relatório de performance...', 'Progresso', -1);
  renderizarPlanilhaPerformance();

  SpreadsheetApp.flush();
  ss.toast('Relatório Gerado com Sucesso!', 'Concluído', 10);
}


// ===================================================================================
// LÓGICA DE ATUALIZAÇÃO DO BANCO DE DADOS
// ===================================================================================

function descobrirParticipacoesPendentes() {
  const participacoesPendentes = new Map();

  // 1. Descobre participações RATED
  const resRating = fazerRequisicaoAPI('user.rating', { handle: CONFIG.atleta });
  if (resRating.success) {
    resRating.data.forEach(c => {
      const key = `${c.contestId}_CONTESTANT`;
      participacoesPendentes.set(key, { contestId: c.contestId.toString(), tipo: 'CONTESTANT' });
    });
  }

  // 2. Descobre participações VIRTUAL
  const resStatus = fazerRequisicaoAPI('user.status', { handle: CONFIG.atleta, from: 1, count: 2000 });
  if (resStatus.success) {
    resStatus.data.forEach(sub => {
      if (sub.contestId && sub.author.participantType === 'VIRTUAL') {
        const key = `${sub.contestId}_VIRTUAL`;
        participacoesPendentes.set(key, { contestId: sub.contestId.toString(), tipo: 'VIRTUAL' });
      }
    });
  }

  // 3. Filtra o que já foi salvo
  const sheetParticipacoes = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DB_PARTICIPACOES_SHEET);
  const participacoesJaSalvas = new Set(sheetParticipacoes.getRange('A2:A').getValues().flat().filter(String));
  
  const tarefas = [];
  participacoesPendentes.forEach((value, key) => {
    const uniqueId = `${value.contestId}_${CONFIG.atleta}_${value.tipo}`;
    if (!participacoesJaSalvas.has(uniqueId)) {
      tarefas.push(value);
    }
  });
  
  // Ordena para processar os mais recentes primeiro
  tarefas.sort((a,b) => parseInt(b.contestId, 10) - parseInt(a.contestId, 10));

  return tarefas;
}

function atualizarBancoDeDados() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetContests = ss.getSheetByName(DB_CONTESTS_SHEET);
  const sheetProblems = ss.getSheetByName(DB_PROBLEMS_SHEET);
  const sheetParticipacoes = ss.getSheetByName(DB_PARTICIPACOES_SHEET);
  
  const tarefas = descobrirParticipacoesPendentes();
  if (tarefas.length === 0) {
    Logger.log("Nenhuma nova participação para processar.");
    ss.toast("Banco de dados já está atualizado.", 'Progresso', 5);
    return;
  }

  const LIMITE_DE_PROCESSAMENTO_POR_EXECUCAO = 20;
  const loteParaProcessar = tarefas.slice(0, LIMITE_DE_PROCESSAMENTO_POR_EXECUCAO);

  Logger.log(`Total de novas participações a processar: ${tarefas.length}. Processando um lote de até ${loteParaProcessar.length}.`);

  for (const tarefa of loteParaProcessar) {
    const contestId = tarefa.contestId;
    ss.toast(`Processando Contest ID: ${contestId} (${tarefa.tipo})`, 'Progresso');

    const standingsRes = fazerRequisicaoAPI('contest.standings', { contestId: contestId, handles: CONFIG.todosHandles.join(';'), showUnofficial: true });
    if (!standingsRes.success) {
      Logger.log(`Não foi possível buscar standings para o contest ${contestId}. Pulando.`);
      continue;
    }
    const standingsData = standingsRes.data;

    // Salva dados do Contest (se ainda não foi salvo)
    const contestsJaSalvos = new Set(sheetContests.getRange('A2:A').getValues().flat().filter(String).map(String));
    if (!contestsJaSalvos.has(contestId)) {
      sheetContests.appendRow([contestId, standingsData.contest.name, standingsData.contest.startTimeSeconds || 0, standingsData.contest.type]);
      standingsData.problems.forEach(prob => {
        sheetProblems.appendRow([`${contestId}_${prob.index}`, contestId, prob.index, prob.rating || '', '', '']);
      });
    }

    // Salva dados das Participações dos atletas de interesse para ESTE contest
    standingsData.rows.forEach(row => {
      if (!row.party.members || row.party.members.length === 0 || !CONFIG.todosHandles.includes(row.party.members[0].handle)) return;
      const pTipo = row.party.participantType;
      if (pTipo === 'PRACTICE') return;

      const handle = row.party.members[0].handle;
      const uniqueId = `${contestId}_${handle}_${pTipo}`;
      
      const participacoesJaSalvasSet = new Set(sheetParticipacoes.getRange('A2:A').getValues().flat().filter(String));
      if(participacoesJaSalvasSet.has(uniqueId)) return;

      const problemsSolved = row.problemResults.filter(p => p.points > 0).length;
      const richProblemResults = row.problemResults.map(pr => ({ p: pr.points, r: pr.rejectedAttemptCount, t: pr.bestSubmissionTimeSeconds }));
      sheetParticipacoes.appendRow([uniqueId, contestId, handle, pTipo, row.rank, problemsSolved, JSON.stringify(richProblemResults)]);
    });
  }

  if (loteParaProcessar.length > 0) {
    ss.toast(`Lote de ${loteParaProcessar.length} participações processado. Execute novamente para o próximo lote.`, 'Progresso', 10);
  }
}

// ===================================================================================
// RENDERIZAÇÃO E CÁLCULOS
// ===================================================================================

function renderizarPlanilhaPerformance() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dbContests = ss.getSheetByName(DB_CONTESTS_SHEET).getDataRange().getValues().slice(1);
  const dbProblems = ss.getSheetByName(DB_PROBLEMS_SHEET).getDataRange().getValues().slice(1);
  const dbParticipacoes = ss.getSheetByName(DB_PARTICIPACOES_SHEET).getDataRange().getValues().slice(1);

  const resRating = fazerRequisicaoAPI('user.rating', { handle: CONFIG.atleta });
  const ratingChangesMap = new Map();
  if (resRating.success) {
    resRating.data.forEach(rc => ratingChangesMap.set(rc.contestId.toString(), rc));
  }

  const contestsMap = new Map();
  let maxProblems = 0;
  dbContests.forEach(row => {
    const contestId = row[0].toString();
    const problems = dbProblems.filter(p => p[1].toString() === contestId).sort((a,b) => a[2].localeCompare(b[2]));
    contestsMap.set(contestId, {id: contestId, name: row[1], startTime: row[2], tipo: row[3], problems: problems});
    if (problems.length > maxProblems) maxProblems = problems.length;
  });

  const participacoesMap = new Map();
  dbParticipacoes.forEach(row => {
    const uniqueId = row[0].toString();
    participacoesMap.set(uniqueId, {uniqueId: uniqueId, contestId: row[1].toString(), handle: row[2], tipo: row[3], rank: row[4], solved: row[5], results: JSON.parse(row[6] || '[]')})
  });
  
  const problemStatsMap = new Map();
  dbProblems.forEach(row => problemStatsMap.set(row[0], {accepted: row[4], tried: row[5]}));

  const participacoesAtleta = Array.from(participacoesMap.values()).filter(p => p.handle === CONFIG.atleta);
  participacoesAtleta.sort((a,b) => {
      const timeA = contestsMap.get(a.contestId) ? contestsMap.get(a.contestId).startTime : 0;
      const timeB = contestsMap.get(b.contestId) ? contestsMap.get(b.contestId).startTime : 0;
      return timeB - timeA;
  });

  let sheet = ss.getSheetByName(PERFORMANCE_SHEET);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(PERFORMANCE_SHEET, 0);
  criarPlanilhaBaseDinamica(sheet, maxProblems);

  const dadosParaPlanilha = [], backgroundsParaPlanilha = [];
  let rankAnterior = null;

  for (const atletaData of participacoesAtleta) {
    const contestData = contestsMap.get(atletaData.contestId);
    if (!contestData) continue;
    
    const participacoesDoContest = Array.from(participacoesMap.values()).filter(p => p.contestId === atletaData.contestId);

    const dataHora = new Date(contestData.startTime * 1000);
    const data = dataHora.toLocaleDateString('pt-BR');
    const hora = dataHora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    let ratingStr = '', ratingChangeStr = '', newRankStr = '';
    const ratingChange = ratingChangesMap.get(atletaData.contestId);
    if (ratingChange) {
      ratingStr = ratingChange.newRating;
      newRankStr = getRankFromRating(ratingChange.newRating);
      if (atletaData.tipo === 'CONTESTANT') {
        const change = ratingChange.newRating - ratingChange.oldRating;
        ratingChangeStr = change > 0 ? `+${change}` : (change < 0 ? `${change}` : '0');
      }
    }
    
    const { problemValues, problemBackgrounds } = getProblemGridData(contestData.problems, atletaData, maxProblems);
    
    const upsolvingCount = calcularUpsolving(CONFIG.atleta, contestData.id, contestData.startTime + (contestData.tipo === 'CF' ? 7200:18000));
    
    const analiseRank = calcularAnaliseRank(atletaData.rank, rankAnterior, CONFIG.boaPosicaoRanking, atletaData.tipo);
    const analiseAcSub = calcularAnaliseAcSub(contestData.problems, atletaData, problemStatsMap);
    const analiseMesmoNivel = calcularAnaliseComparativa(atletaData, participacoesDoContest, CONFIG.benchmarksMesmoNivel, 'rank');
    const analiseNivelAcima = calcularAnaliseComparativa(atletaData, participacoesDoContest, CONFIG.benchmarksNivelAcima, 'solved');
    const analiseTempo = calcularAnaliseTempo(atletaData, participacoesDoContest, [...CONFIG.benchmarksMesmoNivel, ...CONFIG.benchmarksNivelAcima], CONFIG.margemTempoAC);
    
    const tipoDisplay = atletaData.tipo === 'CONTESTANT' ? 'Rated' : 'Virtual';

    const linhaBase = [ contestData.name, tipoDisplay, data, hora, atletaData.rank, ratingStr, ratingChangeStr, newRankStr ];
    const upsolvingDisplay = upsolvingCount > 0 ? `${upsolvingCount}` : '';
    const linhaAnalise = [ analiseRank, analiseAcSub, analiseMesmoNivel, analiseNivelAcima, analiseTempo ];
    
    const linhaCompleta = [...linhaBase, ...problemValues, upsolvingDisplay, ...linhaAnalise];
    dadosParaPlanilha.push(linhaCompleta);

    const background = Array(linhaCompleta.length).fill(null);
    if (tipoDisplay === 'Rated') background[1] = '#d9ead3';
    else if (tipoDisplay === 'Virtual') background[1] = '#cfe2f3';
    
    if (ratingChange && atletaData.tipo === 'CONTESTANT') {
      const changeVal = ratingChange.newRating - ratingChange.oldRating;
      background[6] = changeVal < 0 ? '#f4cccc' : (changeVal > 0 ? '#d9ead3' : null);
    }
    problemBackgrounds.forEach((b, i) => { if(b) background[i + 8] = b });
    backgroundsParaPlanilha.push(background);

    if (atletaData.tipo === 'CONTESTANT') rankAnterior = atletaData.rank;
  }
  
  escreverDadosNaPlanilha(sheet, dadosParaPlanilha, backgroundsParaPlanilha);
}

function getProblemGridData(problems, atletaData, maxProblems) {
  const problemValues = Array(maxProblems).fill('');
  const problemBackgrounds = Array(maxProblems).fill(null);
  
  if (!problems || problems.length === 0 || !atletaData || !atletaData.results) {
      return { problemValues, problemBackgrounds };
  }
  
  problems.forEach((p, i) => {
    const problemRating = p[3] || '';
    const problemResult = atletaData.results[i];
    const isSolvedInContest = problemResult && problemResult.p > 0;
    const hasTried = problemResult && problemResult.r > 0;

    if (isSolvedInContest) {
        const submissionTimeSeconds = problemResult.t;
        const minutes = Math.floor(submissionTimeSeconds / 60).toString().padStart(2, '0');
        const seconds = (submissionTimeSeconds % 60).toString().padStart(2, '0');
        problemValues[i] = `${problemRating} (${minutes}:${seconds})`;
        problemBackgrounds[i] = '#c6f5c6';
    } else if (hasTried) {
        problemValues[i] = problemRating;
        problemBackgrounds[i] = '#f4cccc';
    } else {
        problemValues[i] = problemRating;
        problemBackgrounds[i] = '#efefef';
    }
  });

  return { problemValues, problemBackgrounds };
}


// ===================================================================================
// FUNÇÕES DE APOIO E ESTRUTURA
// ===================================================================================

function fazerRequisicaoAPI(methodName, params) {
  const url = `https://codeforces.com/api/${methodName}?` + Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  Logger.log(`Chamando API: ${url}`);
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); const responseCode = response.getResponseCode(); const content = response.getContentText();
    if (responseCode === 200) { const json = JSON.parse(content); if (json.status === 'OK') return { success: true, data: json.result, error: null }; else { Logger.log(`API FAILED: ${json.comment}`); return { success: false, data: null, error: json.comment || "Erro da API." }; }
    } else { Logger.log(`HTTP ERROR: ${responseCode}`); return { success: false, data: null, error: `Erro HTTP ${responseCode}.` }; }
  } catch (e) { Logger.log(`CONNECTION ERROR: ${e.toString()}`); return { success: false, data: null, error: `Erro de conexão: ${e.toString()}` };
  } finally {
    Utilities.sleep(2100);
  }
}

function criarPlanilhaBaseDinamica(sheet, numProblems) {
    const colunasBase = 8;
    const colunasProblemas = numProblems > 0 ? numProblems : 1;
    const colunasAnalise = 6;
    const totalColunas = colunasBase + colunasProblemas + colunasAnalise;

    sheet.clear();
    
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setFontFamily('Nunito').setFontSize(10).setVerticalAlignment('middle').setHorizontalAlignment('center');

    const titleRange = sheet.getRange(1, 3, 1, totalColunas - 2);
    titleRange.merge().setValue('📈 RELATÓRIO DE CONTESTS - LEONARDO POTTES');
    titleRange.setBackground('#4285f4').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setRowHeight(1, 35);

    const sectionHeaders = sheet.getRange(2, 1, 1, totalColunas);
    sectionHeaders.setBackground('#000000').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(2, 1).setValue('TÍTULO');
    sheet.getRange(2, 2).setValue('TIPO');
    sheet.getRange(2, 3).setValue('CONTEST');
    sheet.getRange(2, 9).setValue('PROBLEMAS');
    const colAnaliseInicio = colunasBase + colunasProblemas + 1;
    sheet.getRange(2, colAnaliseInicio).setValue('ANÁLISES');
    sheet.setRowHeight(2, 35);

    const subHeadersRange = sheet.getRange(3, 1, 1, totalColunas);
    subHeadersRange.setBackground('#434343').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(3, 3).setValue('DATA');
    sheet.getRange(3, 4).setValue('HORA');
    sheet.getRange(3, 5).setValue('RANK');
    sheet.getRange(3, 6).setValue('RATING');
    for (let i = 0; i < colunasProblemas; i++) {
        sheet.getRange(3, 9 + i).setValue(`${i + 1} (${String.fromCharCode(65 + i)})`);
    }
    sheet.getRange(3, colAnaliseInicio).setValue('UPSOLVING');
    sheet.getRange(3, colAnaliseInicio + 1).setValue('RANK');
    sheet.getRange(3, colAnaliseInicio + 2).setValue('AC/SUB');
    sheet.getRange(3, colAnaliseInicio + 3).setValue('MESMO NÍVEL');
    sheet.getRange(3, colAnaliseInicio + 4).setValue('NÍVEL ACIMA');
    sheet.getRange(3, colAnaliseInicio + 5).setValue('TEMPO');
    sheet.setRowHeight(3, 25);

    sheet.getRange(2, 3, 1, 6).merge();
    sheet.getRange(2, 9, 1, colunasProblemas).merge();
    sheet.getRange(2, colAnaliseInicio, 1, colunasAnalise).merge();
    sheet.getRange(3, 6, 1, 3).merge();
    sheet.getRange('A2:A3').merge();
    sheet.getRange('B2:B3').merge();

    sheet.setFrozenRows(3);
    sheet.setFrozenColumns(2);
}


function escreverDadosNaPlanilha(sheet, dados, backgrounds) {
  if (!dados || dados.length === 0) { return; }
  const START_ROW = 4;
  const NUM_ROWS = dados.length; 
  const NUM_COLS = dados[0].length;
  
  const oldDataRange = sheet.getRange(START_ROW, 1, Math.max(1, sheet.getMaxRows() - START_ROW + 1), sheet.getMaxColumns());
  oldDataRange.clear({contentsOnly: true, formatOnly: true, commentsOnly: true});
  
  if (NUM_ROWS > 0) {
    const dataRange = sheet.getRange(START_ROW, 1, NUM_ROWS, NUM_COLS);
    dataRange.setValues(dados);
    dataRange.setFontFamily('Nunito').setFontSize(10).setVerticalAlignment('middle').setHorizontalAlignment('center');
    if(backgrounds && backgrounds.length === NUM_ROWS) dataRange.setBackgrounds(backgrounds);
  }
  
  for (let i = 1; i <= NUM_COLS; i++) { sheet.autoResizeColumn(i); }
  const lastRow = sheet.getLastRow(); const maxRows = sheet.getMaxRows(); if (maxRows > lastRow && lastRow >= START_ROW) sheet.deleteRows(lastRow + 1, maxRows - lastRow);
  const lastCol = sheet.getLastColumn(); const maxCols = sheet.getMaxColumns(); if (maxCols > lastCol && lastCol > 0) sheet.deleteColumns(lastCol + 1, maxCols - lastCol);
}


function carregarConfiguracoes() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Configurações"); if (!sheet) { SpreadsheetApp.getUi().alert("Aba \"Configurações\" não encontrada."); return false; }
  const data = sheet.getRange("A2:B6").getValues(); CONFIG.atleta = data[0][1].toString().trim(); CONFIG.benchmarksMesmoNivel = data[1][1].toString().split(",").map(e => e.trim()).filter(e => e); CONFIG.benchmarksNivelAcima = data[2][1].toString().split(",").map(e => e.trim()).filter(e => e);
  CONFIG.boaPosicaoRanking = parseInt(data[3][1], 10); CONFIG.margemTempoAC = parseInt(data[4][1], 10);
  if (!CONFIG.atleta) { SpreadsheetApp.getUi().alert('O "HANDLE DO ATLETA" não pode estar vazio.'); return false; }
  CONFIG.todosHandles = [...new Set([CONFIG.atleta, ...CONFIG.benchmarksMesmoNivel, ...CONFIG.benchmarksNivelAcima])]; return true;
}

function criarAbaConfiguracoes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); let sheet = ss.getSheetByName("Configurações"); if (!sheet) sheet = ss.insertSheet("Configurações", 0); sheet.clear(); const ui = SpreadsheetApp.getUi(); ui.alert("Criando/Zerando a aba de Configurações...");
  const headerRange = sheet.getRange("A1:B1"); headerRange.merge().setValue("⚙️ CONFIGURAÇÕES").setBackground("#4285f4").setFontColor("#ffffff").setFontWeight("bold").setHorizontalAlignment("center");
  const data = [["HANDLE DO ATLETA"], ["HANDLES DE ATLETAS DE MESMO NÍVEL"], ["HANDLES DE ATLETAS DE NÍVEL ACIMA"], ["BOA POSIÇÃO NO RANKING"], ["MARGEM DE TEMPO PARA AC (minutos)"]];
  sheet.getRange("A2:B6").setValues(data); sheet.getRange("A2:A6").setBackground("#000000").setFontColor("#ffffff").setFontWeight("bold"); sheet.getRange("A1:B6").setFontFamily("Nunito").setFontSize(10).setVerticalAlignment("middle");
  sheet.getRange("B2:B6").setHorizontalAlignment("left"); sheet.setColumnWidth(1, 250); sheet.setColumnWidth(2, 600); ui.alert("Aba de Configurações criada com sucesso!");
}

function criarAbasDeBancoDeDados() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const sheets = { 
    [DB_CONTESTS_SHEET]: ["contestId", "contestName", "startTimeSeconds", "tipo"], 
    [DB_PROBLEMS_SHEET]: ["problemId", "contestId", "index", "rating", "accepted", "tried"], 
    [DB_PARTICIPACOES_SHEET]: ["uniqueId", "contestId", "handle", "tipo", "rank", "problemsSolved", "problemResults_RICH (JSON)"]
  };
  for (const sheetName in sheets) {
    let sheet = ss.getSheetByName(sheetName); if (!sheet) sheet = ss.insertSheet(sheetName); sheet.clear();
    sheet.getRange(1, 1, 1, sheets[sheetName].length).setValues([sheets[sheetName]]).setFontWeight('bold');
  }
  ui.alert("Abas de Banco de Dados criadas/zeradas com sucesso!");
}

// ===================================================================================
// FUNÇÕES DE CÁLCULO DE ANÁLISE
// ===================================================================================

function getRankFromRating(rating) {
    if (rating >= 3000) return 'Legendary Grandmaster'; if (rating >= 2600) return 'International Grandmaster'; if (rating >= 2400) return 'Grandmaster';
    if (rating >= 2300) return 'International Master'; if (rating >= 2100) return 'Master'; if (rating >= 1900) return 'Candidate Master';
    if (rating >= 1600) return 'Expert'; if (rating >= 1400) return 'Specialist'; if (rating >= 1200) return 'Pupil';
    return 'Newbie';
}

function calcularAnaliseRank(rank, prevRank, boaPosicao, tipo) {
  if (tipo !== 'CONTESTANT' || !rank || rank === 0) return "";
  let emoji1 = rank <= boaPosicao ? '✅' : '⛔';
  let emoji2 = '';
  if (prevRank && prevRank !== 0) {
    if (rank < prevRank) emoji2 = '📈';
    else if (rank > prevRank) emoji2 = '📉';
    else emoji2 = '➡️';
  }
  return emoji1 + emoji2;
}


function calcularAnaliseAcSub(problems, atletaData, problemStatsMap) {
    if (!problems || !atletaData || !atletaData.results || !problemStatsMap) return '';
    let emojis = '';
    problems.forEach((problemInfo, i) => {
        const result = atletaData.results[i];
        if (!result) {
            emojis += '➖';
            return;
        }

        const problemId = `${problemInfo[1]}_${problemInfo[2]}`;
        const stats = problemStatsMap.get(problemId);

        let dificuldade = 'media';
        if (stats && stats.tried > 0) {
            const accepted = parseInt(stats.accepted, 10);
            const tried = parseInt(stats.tried, 10);
            if (tried > 0) {
              const ratio = accepted / tried;
              if (ratio < 0.25) dificuldade = 'dificil';
              else if (ratio > 0.75) dificuldade = 'facil';
            }
        }

        if (result.p > 0) {
            emojis += (dificuldade === 'dificil') ? '🔥' : '✅';
        } else if (result.r > 0) {
            emojis += (dificuldade === 'facil') ? '⚠️' : '❌';
        } else {
            emojis += '➖';
        }
    });
    return emojis;
}


function calcularAnaliseComparativa(atletaData, todasParticipacoes, benchmarkHandles, metrica) {
    const benchmarksQueParticiparam = todasParticipacoes.filter(p => benchmarkHandles.includes(p.handle) && p.handle !== atletaData.handle && p.tipo === atletaData.tipo);
    if (benchmarksQueParticiparam.length === 0) return "N/A";
    
    let atletaMelhorQue = 0;
    const valorAtleta = atletaData[metrica];
    if (atletaData.tipo !== 'CONTESTANT' && metrica === 'rank') return "N/A";

    benchmarksQueParticiparam.forEach(b => {
        const valorBenchmark = b[metrica];
        if (metrica === 'rank') { if (valorAtleta < valorBenchmark) atletaMelhorQue++; } 
        else { if (valorAtleta > valorBenchmark) atletaMelhorQue++; }
    });

    const percentual = Math.round((atletaMelhorQue / benchmarksQueParticiparam.length) * 100);
    return `Melhor que ${percentual}%`;
}


function calcularAnaliseTempo(atletaData, todasParticipacoes, benchmarkHandles, margemMinutos) {
    if(!atletaData || !atletaData.results) return 'N/A';
    const benchmarksQueParticiparam = todasParticipacoes.filter(p => benchmarkHandles.includes(p.handle) && p.tipo === atletaData.tipo);
    if (benchmarksQueParticiparam.length === 0) return 'N/A';
    
    let maisRapidoCount = 0, maisLentoCount = 0, problemasComparados = 0;
    const margemSegundos = margemMinutos * 60;

    atletaData.results.forEach((res, i) => {
        if (res.p > 0 && res.t) { 
            const temposBenchmark = benchmarksQueParticiparam
                .map(b => b.results[i] ? b.results[i].t : null)
                .filter(t => t); 
            
            if (temposBenchmark.length > 0) {
                problemasComparados++;
                const mediaTempoBenchmark = temposBenchmark.reduce((a,b) => a+b, 0) / temposBenchmark.length;
                if (res.t < mediaTempoBenchmark) maisRapidoCount++;
                if (res.t > mediaTempoBenchmark + margemSegundos) maisLentoCount++;
            }
        }
    });
    
    if (problemasComparados === 0) return 'N/A';
    if (maisLentoCount > problemasComparados / 2) return '⬆️';
    if (maisRapidoCount > problemasComparados / 2) return '⬇️';
    return '➡️';
}

function calcularUpsolving(handle, contestId, contestEndTime) {
  let upsolvedCount = 0;
  // Vamos buscar as últimas 500 submissões gerais.
  const resStatus = fazerRequisicaoAPI('user.status', { handle: handle, from: 1, count: 500 });
  if (resStatus.success) {
      const upsolvedProblems = new Set();
      resStatus.data.forEach(sub => {
          // Verifica se a submissão foi OK, é do contest correto, e aconteceu DEPOIS do fim do contest
          if (sub.verdict === 'OK' && sub.contestId.toString() === contestId && sub.creationTimeSeconds > contestEndTime) {
              upsolvedProblems.add(sub.problem.index);
          }
      });
      upsolvedCount = upsolvedProblems.size;
  }
  return upsolvedCount;
}
