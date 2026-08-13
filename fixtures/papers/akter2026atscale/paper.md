---
title: At-Scale Data-Driven Exploration of High-Voltage Cathode-Active Materials for Sodium Batteries
author:
- name: Suchona Akter
- name: Mohammad R. Momeni
date: '2010'
abstract: >-
  Sodium-ion batteries (SIBs) share similar electrochemistry with Li but offer several advantages, including high abundance in nature and low cost, as well as suitability for fast charging due to a Na-ion mobility higher than that of Li. The development of high-voltage SIBs heavily relies on the discovery of novel, robust cathode-active materials (CAMs). All-inorganic materials represent the most mature and practical choice as CAMs for next-generation SIBs; however, their family spans a vast and chemically diverse space. In this work, we present a large-scale, chemically validated database of stable materials for SIB cathode discovery, curated from four major databases: Materials Project, AFLOW, OQMD, and GNoME. Generalizable and transferable descriptor-based machine learning (ML) models are developed based on a dataset of charged-only structures rather than charged/discharged pairs. Using a committee of the top four trained ML models, average voltage and specific capacity are predicted as target properties. Finally, a subset of top-ranked candidate CAMs is validated through explicit, high-throughput first-principles calculations of voltage profiles, phase stability, structural robustness upon sodiation/desodiation, and electronic properties. Together, this integrated data curation, ML ranking and predictions, and first-principles validation strategy establishes a scalable and transferable framework for accelerating the discovery of stable, high-voltage CAMs for SIBs and beyond.
lang: en
---

# At-Scale Data-Driven Exploration of High-Voltage Cathode-Active Materials for Sodium Batteries
Suchona Akter and Mohammad R. Momeni\* Division of Energy, Matter and Systems, School of Science and Engineering, University of Missouri – Kansas City, Kansas City 64110, MO United States E-mail: mmomenitaheri@umkc.edu

# Abstract
Sodium-ion batteries (SIBs) share similar electrochemistry with Li but offer several advantages, including high abundance in nature and low cost, as well as suitability for fast charging due to a Na-ion mobility higher than that of Li. The development of high-voltage SIBs heavily relies on the discovery of novel, robust cathode-active materials (CAMs). All-inorganic materials represent the most mature and practical choice as CAMs for next-generation SIBs; however, their family spans a vast and chemically diverse space. In this work, we present a large-scale, chemically validated database of stable materials for SIB cathode discovery, curated from four major databases: Materials Project, AFLOW, OQMD, and GNoME. Generalizable and transferable descriptor-based machine learning (ML) models are developed based on a dataset of charged-only structures rather than charged/discharged pairs. Using a committee of the top four trained ML models, average voltage and specific capacity are predicted as target properties. Finally, a subset of top-ranked candidate CAMs is validated through explicit, high-throughput first-principles calculations of voltage profiles, phase stability, structural robustness upon sodiation/desodiation, and electronic properties. Together, this integrated data curation, ML ranking and predictions, and first-principles validation strategy establishes a scalable and transferable framework for accelerating the discovery of stable, high-voltage CAMs for SIBs and beyond.

# 1. INTRODUCTION
Building a low-carbon society based on clean and sustainable energy has become a critical scientific challenge of the 21 $^{st}$ century. $^{1-3}$ In this quest for renewable energy, electrochemical energy storage plays a central role given the intermittent nature of solar and wind. $^{4}$ Among available technologies to date, lithium-ion batteries (LIBs) have become the leading platform for energy storage, thanks to their high energy density, long cycle life, and high operating voltages. $^{1,5-7}$ Despite their commercial success, Li is considered a semi-rare element with a highly uneven distribution worldwide. $^{8}$ The environmental impact of Li extraction is of significant concern as well. $^{9}$ Simultaneously, the rapid growth in demand for consumer electronics and stationary grid energy storage is driving the evolution of new rechargeable ion battery technologies toward lower cost, higher capacity and voltage, longer cycle life, faster charging, and improved safety, among others. $^{10}$ In this regard, sodium-ion batteries (SIBs), which share similar electrochemistry with LIBs, offer several advantages, particularly their high abundance in nature and low cost. $^{11}$ Na, the sixth most abundant element in the Earth's crust, is distributed almost without limits. $^{12}$ The significantly lower cost of the trona mineral ( $\approx$ 135-165 per ton) used to produce sodium carbonate, compared with lithium carbonate ( $\approx$ 5000 per ton in 2010), strongly supports the development of SIBs as viable alternatives to LIBs. $^{13,14}$

To enable practical implementations, next-generation SIBs must combine higher energy and power densities with improved cycle life, superior safety, and reduced cost. These parameters are intrinsically linked to the crystal structure and chemical composition of the electrode active materials, in which intercalation-deintercalation of working ions occurs during discharging-charging. CAMs, as the principal determinant of a battery's core performance metrics, account for approximately 40% of the device's overall cost. $^{15}$ Specifically, SIB cathodes face two major challenges. First, SIBs have lower gravimetric energy density than LIBs due to Na's higher atomic mass. $^{16}$ Second, the $Na^{+}$ ion has a larger ionic radius (1.02 Å) compared to that of the $Li^{+}$ (0.76 Å), causing larger volume changes during charge and discharge cycles, resulting in possible deterioration of the structural stability. $^{14}$ As such, cathode host materials for $Na^{+}$ ions are often prone to phase transitions and deformations, leading to capacity decay and low power density. $^{16,17}$ Therefore, the identification and optimization of new CAMs capable of reversibly intercalating/deintercalating $Na^{+}$ ions with high capacity and stability remain a major research focus. Extensive research efforts to date have led to the development of diverse families of CAMs for SIBs, most notably sodium layered transition-metal oxides (LTMOs, $Na_{x}TMO_{2}$ ) and polyanionic compounds. $^{18-22}$

Layered $Na_{x}TMO_{2}$ materials (TM = Ti, V, Cr, Mn, Fe, Co, Ni, and a mixture of 2 or 3 elements) $^{23}$ are distinguished by their comparatively high energy densities, making them widely applicable in energy storage systems. The feasibility of electrochemistry in single transition-metal layered oxides was first demonstrated in the 1980s. $^{24}$ The specific stacking sequence of the oxide layers and the coordination environment of the alkali ion give rise to different polymorphs. In contrast to octahedral O-type Li-ion layered oxides, Na-ion oxides exhibit greater structural versatility and are generally classified into two main groups: the O3 type, where Na ions occupy octahedral sites, and the P2 type, where Na ions reside in prismatic sites. $^{25,26}$ The P2-type oxides are found to offer better structural stability, higher Na-ion conductivity, and more open channels for ion diffusion compared to O3 structures, resulting in lower diffusion barriers and better power density and cycling stability. $^{27}$

In addition to LTMOs, polyanionic materials are pivotal as CAMs for SIBs and can be classified by their crystal structures as olivine, $^{28}$ alluaudite, $^{29}$ favorite, $^{30}$ Na $_{3}$ V $_{2}$ (PO4) $_{2}$ F $_{3}$ , $^{31}$ and NA-Super-Ionic-CONductor $^{32}$ (NASICON)-type structures. Phosphate-based materials can be categorized into four subgroups: (i) single-phosphate compounds (NaMPO $_{4}$ , M = transition metal), (ii) NASICON-type phosphates $(\mathrm{Na}_{x}\mathrm{M}_{2}(\mathrm{PO}_{4})_{3})$ , (iii) pyrophosphates and mixed polyanions $(\mathrm{Na}_{2}\mathrm{MP}_{2}\mathrm{O}_{2}$ and $\mathrm{Na}_{4}\mathrm{M}_{3}(\mathrm{PO}_{3})_{2}\mathrm{P}_{2}\mathrm{O}_{7})$ , and (iv) fluorophosphates. $^{33}$ Among these, NASICON-type materials have been extensively studied as CAMs for SIBs. First reported in 1976, $^{32}$ NASICONs have the general formula $\mathrm{A}_{n}\mathrm{M}_{2}(\mathrm{XO}_{4})_{3}$ , where A denotes an alkali-metal ion or vacancy, M is a transition metal or main-group element, and X = S, P, Si, or As. Strong covalent linkages between $XO_{4}$ tetrahedra and $MO_{6}$ octahedra form a rigid 3D architecture that provides excellent cycling stability. Practical electrochemical activity of NASICONs in SIBs was first demonstrated in the mid-1980s by Delmas et al. $^{34}$ using $\mathrm{NaTi}_{2}(\mathrm{PO}_{4})_{3}$ .

<!-- page: 2 -->

![Figure 1](images/fig1.jpg)
Figure 1: Adapted workflow in this work. A dataset comprised of charged structures from the MP battery database is used to train descriptor-based ML models. The trained models are then applied to a carefully curated materials database collected from MP, AFLOW, OQMD, and GNoME to predict voltage and specific capacity using a committee of top-ranked ML models.

The list of drawbacks is rather long for CAMs designed to date for SIBs. For example, LTMO-based cathodes suffer from irreversible phase transitions, limited energy density, and poor air stability. $^{35,36}$ Polyanionic compounds, on the other hand, offer greater stability but generally exhibit inferior intrinsic electrical conductivity and lower capacity. $^{37,38}$ Therefore, further research is needed for optimization of the electrochemical performance of CAMs to deliver superior properties for practical applications.

To accelerate materials discovery, computational high-throughput screening approaches combining first-principles calculations and machine learning (ML) have become increasingly important tools in battery research. $^{39}$ High-throughput density functional theory (DFT) calculations have been widely used to evaluate structural properties, thermodynamic stability, and electrochemical performance of CAMs across large materials databases. $^{40}$ More recently, trained ML models have also been integrated with high-throughput calculations to predict electrochemical properties such as voltage and capacity from structural and compositional descriptors, enabling rapid exploration of large chemical spaces that would otherwise be inaccessible through brute-force DFT calculations alone. $^{41}$ The existing ML workflows for predicting battery-related properties largely rely on pair (i.e., both charged and discharged) structures. This is because, for example, voltage is theoretically determined by the energy difference between the two charged and discharged states of a host material. $^{42}$ Pair-based models can achieve high predictive accuracy and have been successfully used for screening electrode materials within specific structural families, when both states are available. $^{43}$ However, this requirement significantly limits the scalability of these models. In many cases, only one structural state, often the charged or desodiated state, is available in computational databases, while the corresponding discharged state is missing or computationally expensive to generate. As a result, pair-based models cannot be readily applied across large candidate materials spaces without expensive high-throughput DFT calculations. The adoption of sodium-metal anodes (i.e., anode-free SIBs) eliminates the necessity for cathodes to contain sodium in their native state. $^{44,45}$ As such, an alternative strategy is to learn electrochemical trends directly from a single state, particularly from charged or desodiated structures commonly reported in materials databases. $^{46}$ Although such models may understandably sacrifice some predictive accuracy compared with pair-based approaches, $^{11}$ they offer a major advantage in terms of transferability and scalability. By requiring only a single structural representation, charged-only models can be applied to a much wider range of candidate materials, enabling rapid screening across diverse structural families where pair structures are unavailable. However, the feasibility and practical utility of charged-only learning strategies for SIB cathode discovery remain largely unexplored.

Advanced materials developments have been accelerated by the US Materials Genome Initiative via introducing Materials Project (MP), $^{47}$ Automatic-Flow (AFLOW), $^{48}$ and the Open Quantum Materials Database (OQMD) $^{40}$ platforms. The Novel Materials Discovery (NOMAD) lab launched the NOMAD Repository and Archive, $^{49,50}$ the first FAIR (Findable, Accessible, Interoperable, and Reusable) infrastructure for computational materials-science data. Databases specific to 2D materials have also emerged $^{51-53}$ for systematic data mining of the MP, Inorganic Crystal Structure Database (ICSD), and the Crystallography Open Database (COD). $^{54,55}$ These databases already contain thousands of new inorganic materials. The research community would greatly benefit from an all-encompassing, chemically validated dataset dedicated to the discovery of optimal cathode materials for SIBs and beyond.

<!-- page: 3 -->
In this work, we present such a database comprised of unique, chemically validated, and stable materials, specifically curated for SIB cathode discovery. Generalizable descriptor-based ML models are trained using charged-only structures from the MP battery dataset, with average voltage and specific capacity as target properties. Finally, a subset of top-ranked candidate materials is validated through explicit high-throughput DFT calculations to confirm phase stability, voltage profiles, and structural robustness upon sodiation/desodiation. In the Methods section, we first describe the construction of our curated database, followed by details of our ML model training. Our model-agreement-guided predictions using a committee of four ML models, along with the observed chemical trends and high-throughput DFT validations for top candidates, are presented in the Results and Discussion section. Finally, we conclude this work by discussing the implications of our curated database and developed ML models for accelerating CAM discovery for SIBs and beyond.

# 2. METHODS

## 2.1. Database Construction and Curation
Our overall workflow, starting from dataset construction to property prediction, is shown in Figure 1. For data-driven research to yield meaningful results, reliable and high-quality data are crucial. To build a dedicated materials database useful for battery cathode discovery, we begin with the MP database. $^{56}$ The structures in this database originate either from ICSD or data-mined chemical substitution algorithms. $^{57}$ We accessed this database through the Materials Application Programming Interface (MAPI) $^{56}$ via the Python Materials Genomics (pymatgen) package. $^{58}$ We also retrieved crystal structures from OQMD using its OPTIMADE API $^{59}$ endpoint through the pymatgen.ext.optimade.OptimadeRester client. Additionally, structures were mined from the AFLOW repository using the AFLUX REST API $^{60}$ and from the GNOME database via its Google Cloud Storage. $^{61}$

Our data curation workflow is shown in Figure 2. All collected materials from the above-mentioned databases were processed using pymatgen to parse them into a consistent object representation and to compute their key descriptors. The structures were curated with the following steps: (a) toxic, radioactive, and precious-metal-containing materials were removed. These include As, Au, Ir, Pt, Pd, Rh, Tc, and atoms with atomic number greater than 83. $^{62}$ (b) Any structure with Na was removed from the pool. (c) Pymatgen's StructureMatcher function was used to remove duplicate structures, ensuring that only unique systems are included in subsequent high-throughput calculations. $^{63}$ The default tolerance parameters were used for the fractional length (ltol=0.2), site position (stol=0.3), and relative angles (angletol=5°). $^{64}$ (d) Unstable materials were identified and removed. Stability was determined based on either energy above the hull or formation energy. Structures with energy above hull of $\leq0.1$ eV/atom were considered as stable materials. $^{42}$ Structures for which the energy above hull values are unavailable, negative formation energy was considered as the indicator for stability. $^{65}$ The oxidation states of all unique structures were then calculated using pymatgen's BVAnalyzer module with default settings, $^{66,67}$ based on local bonding environments. When the bond valence analysis failed or yielded ambiguous results, an oxidation-state analyzer based on compositional rules and the statistical distribution of oxidation states in ICSD was employed instead. $^{42}$

![Figure 2](images/fig2.jpg)
Figure 2: Data curation workflow. The number of structures remaining after each stage is given. See the main text for more details.

Next, all materials were screened to remove non-extended (i.e., 0D) structures based on structural dimensionality. For this purpose, all materials were parsed using the pymatgen package. $^{58}$ A crystal graph was generated using the CrystalNN near-neighbor algorithm. $^{68}$ The dimensionality of the structure was then evaluated using the Larsen method. $^{69}$ In this analysis, each component is assigned an integer dimensionality of 0, 1, 2, or 3, where a 0D component corresponds to an isolated cluster. Such 0D materials were removed from our database. Finally, any structure containing solvent molecules was removed from our final curated database.

2.2. Composition of the Training Dataset From the MP Battery Explorer, we selected a subset of 416 entries with Na as the working ion. We retrieved key properties, including average voltage, specific capacity, and specific energy. $^{47}$ To construct our training dataset, 292 desodiated charged structures were selected. This training set includes broad chemical and structural diversity, as summarized in the Supporting Information (SI) Figure S1. The number of element types spans from 2 to 5, ensuring compositional complexity. Oxide and phosphate-containing materials are most abundant in the dataset, followed by fluorides, sulfides, and other polyanionic frameworks. O- and P-containing materials are the most common, with transition metals such as Mn, Fe, V, Ni, and Cr frequently serving as redox-active centers. Most voltages in the dataset are concentrated around 2.5–4.5 V, with capacities around 100 mAh g $^{-1}$ , with some as high as 600 mAh g $^{-1}$ . The training dataset also spans multiple crystalline systems, indicating that it is not limited to a single structural family. This diversity ensures an uneven distribution of chemical and property data within our training set.

<!-- page: 4 -->
## 2.3. ML Model Training
Structural and compositional features are constructed for the 292 charged structures selected from the MP battery database. Structural features, including density, volume, lattice parameters, and space groups, are calculated using pymatgen. Compositional features include Na content, transition-metal ratios, oxidation-state ratio, stoichiometric ratios, oxidation-state statistics, and local-environment fingerprints. All features were standardized via median imputation and scaling. All ML models in this work were developed using the scikit-learn package. $^{70}$ Tree-based ensemble models, including gradient boosting (GB), random forest (RF), extremely randomized trees (ET), histogram-based gradient boosting (HGBDT), and XGBoost (XGB), were considered alongside regularized linear models and kernel-based regressors. $^{71}$ These models work especially well for cases where limited labeled data are available. $^{43}$ Earlier battery-screening studies have shown that ensemble and descriptor-based models often outperform graph-based deep learning models when the number of labeled training data is limited. $^{43}$ This is the case in this work, as our training dataset is limited to 292 charged structures (see SI Section S1 for our performance evaluations of the crystal graph convolutional neural network (CGCNN) models). This dataset was split into training and test sets at 80/20. A 10-fold cross-validation (CV) was performed within the training set. The final CV performance was calculated by averaging the evaluation metrics across the ten folds. Four best-performing models were identified based on their 10-fold CV mean absolute error (MAE), with lower values indicating better predictive performance.

## 2.4. DFT Validation of Top Candidates
To assess the reliability of our ML models' predictions, four materials from the top-ranked cathode candidates were selected for high-throughput DFT calculations using atomate2 $^{72}$ together with the Vienna Ab initio Simulation Package (VASP 6.4.3). $^{73-76}$ Standardized parameters from the Materials Project, including the exchange-correlation density functional, dispersion correction, Hubbard U correction, etc., were used for all DFT calculations reported in this work. The Na-insertion workflow is given in the SI Figure S2. Initially, the host structures were fully relaxed using the MP relaxation workflow as implemented in atomate2. Next, favorable and unique Na insertion sites were identified using the charge-density insertion algorithm. $^{77}$ In this scheme, Na ions are inserted into low-electron-density regions identified by DFT calculations. Both atomic positions and cell vectors of the resulting structures were subsequently fully relaxed to determine energetically favorable sodiated configurations.

Two filtering criteria were applied during our Na-insertion calculations. First, the crystal lattice of the inserted structure had to remain structurally similar or topotactic to the original desodiated host structure. This was checked using atomate2, which utilizes pymatgen's StructureMatcher. $^{78}$ Candidates were discarded if no topotactic Na insertion structure could be obtained. Second, structures were removed if the volume increased by more than 20\% compared to the relaxed Na-free host material. $^{62}$ We applied the second filtering criterion because large volume changes are known to lead to poor structural degradation and cycling stability in sodium-ion cathodes. As mentioned previously, this is especially important for SIBs given the relatively larger size of the $Na^{+}$ ions than $Li^{+}$ that can cause significant lattice distortion during intercalation-deintercalation.

The Na insertion voltages were calculated from the total energies of the fully relaxed charged and discharged structures using the equation:

$$
V = - \frac {E (\mathrm{Na} _ {x _ {2}} \text {Host}) - E (\mathrm{Na} _ {x _ {1}} \text {Host}) - (x _ {2} - x _ {1}) E (\mathrm{Na})}{x _ {2} - x _ {1}}\tag{1}
$$
where $E(\mathrm{Na})$ is the DFT energy per atom of the metallic sodium, and $x_{1}$ and $x_{2}$ represent the Na stoichiometries before and after insertion, respectively. The gravimetric specific capacity was calculated using the equation:

$$
C _ {\mathrm{grav}} = \frac {n F}{3 . 6 M _ {\mathrm{discharged}}}\tag{2}
$$
where n is the number of inserted Na ions, F is Faraday's constant, and $M_{discharged}$ is the molar mass of the discharged structure. Band gaps were also calculated using parameters from the Materials Project in VASP. Finally, feature importance was determined from the trained RF, ET, GB, and XGB models using their built-in feature\_importances\_values. The importances were normalized within each model and then averaged across the four models to obtain the final rank.

# 3. RESULTS AND DISCUSSION

## 3.1. ML Model Performance
We first rank our trained ML models by performance (see SI Section S2). Their errors across CV folds, standard deviation, MAEs for train and test sets, and $R^{2}$ values are provided in the SI Tables S1 and S2. Tree-based ensemble models were found to provide the most reliable voltage predictions. The Extra Trees (ET) model achieved the lowest CV MAE of 0.61 V, with a corresponding test MAE of 0.51 V. Other ensemble methods, including RF, XGB, GB, and HGBDT, showed comparable performance, with CV MAEs in the range of 0.61-0.64 V and test MAEs between 0.47 and 0.50 V. The $R^{2}$ values for these models ranged from 0.69 to 0.76, indicating good predictive capability across the dataset. In contrast, the SVR model exhibited higher error (MAE = 0.74 V) and a lower $R^{2}$ (0.52), indicating a weaker performance.

Similar trends in specific capacity predictions were observed (see SI Table S2). Tree-based ensemble models also performed well for specific capacity predictions. The ET model achieved the lowest CV error again (MAE = 31.7 mAh g $^{-1}$ ) and a test MAE of 27.6 mAh g $^{-1}$ , along with an R $^{2}$ value of 0.72. Other ensemble models, including XGB, GB, and RF, showed similar performance, with CV MAEs ranging from $\approx$ 34.0 to 36.0 mAh g $^{-1}$ and test MAEs between 29.0 and 32.0 mAh g $^{-1}$ . In contrast, the HGBDT model showed higher error and lower R $^{2}$ , while the SVR model performed worst, with much larger errors and very low predictive accuracy. The MP battery dataset contains pair features for a battery system (i.e., both charged and discharged structures). As we are interested only in predictions from the charged structures, we did not include pair features, even though we found that including them reduces errors, as expected. The best-performing models for both voltage and specific capacity predictions are ET, RF, XGB, and GB. We used these 4 models for prediction across all

<!-- page: 5 -->
curated materials databases.

## 3.2. Model-Agreement-Guided Predictions Across the Curated Materials Database
To evaluate the reliability of our ML predictions, Spearman rank correlations were calculated for the top four ML models within the curated materials from each database. The resulting correlation matrices for the predicted voltages are provided in the SI Figure S3. MP shows the strongest model agreement, with pairwise rank correlations ranging from 0.87 to 0.97. This indicates that the four models produce very similar candidate orderings for MP structures. The strongest agreement is observed between RF and XGB, while GB still remains strongly correlated with the other models. OQMD also shows strong rank consistency, with correlations mostly above 0.85, except for the ET–GB pair. AFLOW shows moderate-to-strong agreement, but the correlations are lower than in MP. GNoME has the weakest ranking consistency among models, mainly because GB is less correlated with the other three models. In GNoME, the ET–GB correlation is only 0.56, while RF and XGB remain strongly correlated with ET and with each other. This suggests that GNoME contains a larger fraction of structures for which the models predict differently. Such behavior is reasonable considering that GNoME contains many hypothetical structures that differ from the chemical and structural environments represented in our training set.

The Spearman correlations for the predicted specific capacities (SI Figure S4) show a similar database dependence, but the model agreement is generally slightly poorer than that observed for voltages. MP and OQMD again show the most consistent rankings, with RF and XGB giving the strongest agreement and correlations above 0.90. GB also correlates strongly with RF and XGB in these two databases, indicating that the ensemble models identify similar high-capacity candidates for the more chemically familiar materials spaces. In contrast, AFLOW shows only moderate agreement involving ET, although GB, RF, and XGB remain strongly correlated with each other. GNoME exhibits the weakest capacity-ranking consistency, with low correlations between ET and GB or XGB. This indicates that capacity prediction is more sensitive to model choice than voltage, especially for generated structures that are farther from the training domain.

After establishing the reliability of our descriptor-based ML models, the four best-performing models, ET, GB, RF, and XGB, were applied to our full curated dataset. This dataset contains 840,595 desodiated host structures collected from MP, AFLOW, OQMD, and GNoME after the curation and stability filters were applied, as described in Section 2.1 (Figure 2). These structures cover a much broader chemical space than the MP battery training set and therefore provide a stringent test of whether the learned structure-property relationships can be used for large-scale cathode discovery. The same featurization used during model training was applied to all curated structures before prediction. Both voltage and specific capacity were estimated for each candidate. The combination of predicted voltages and capacities enabled us to evaluate not only high-voltage materials but also candidates that maintain a favorable balance between redox potential and charge storage capacity.

Because the curated structures originate from different databases, a single model prediction is not sufficient to evaluate the robustness of our predictions and rankings. We therefore used an ensemble approach, combining predictions from a committee of all four selected models. The mean prediction was used to rank candidates. This strategy identifies candidates that are consistently predicted to be promising from those that receive a high value from only one model. The predicted voltage distributions in Figure 3 show a database-dependent shift in the predicted voltages across all four models. The analogous distribution for specific capacity is given in the SI Figure S5. MP contains the largest fraction of high-voltage candidates, with broad distributions extending above 4.0 V for all four models. This behavior is expected because MP contains many chemically well-characterized inorganic compounds that are close to known cathode material families. In contrast, AFLOW shows a lower and narrower voltage distribution, with most predictions centered near 1–1.5 V. OQMD and GNoME occupy an intermediate region. OQMD shows a broader high-voltage tail than AFLOW, while GNoME contains a compact low-voltage population with fewer high-voltage candidates.

![Figure 3](images/fig3.jpg)
Figure 3: Violin plots of the predicted voltage distributions of curated materials across four databases using the four best-performing ML models, ET, GB, RF, and XGB. The analogous plot for specific capacity is given in the SI Figure S5.

Within each database, the four models preserve a similar qualitative voltage ordering, but nevertheless, they differ in the width and center of the predicted distributions. ET tends to give higher voltages and broader upper tails, especially for MP and OQMD. GB gives more compressed distributions and usually predicts lower voltages. RF and XGB generally lie between these two limits. This model-dependent shift is important because it shows that the model itself can influence the absolute voltage scale, even when the relative trends are similar. For this reason, as mentioned above, we have used the mean predictions in all our candidate rankings.

## 3.3. Chemical Trends Across Material Families
Our predicted properties reveal clear chemical trends across different material families. Figure 4 compares the mean predicted voltages for major (polyanionic) families across our four best-performing ML models. Polyanionic frameworks show the highest predicted voltages overall. In particular, $PO_{3}$ , $P_{2}O_{7}$ , $SO_{4}$ , $PO_{4}$ , and $CO_{3}$ families are predicted near or above 3.2 V by most models. Oxyfluoride and fluoride materials also show relatively high predicted voltages, although the model spread is larger for fluorides. In contrast, the oxide and sulfide families have lower predicted voltages, with sulfides yielding the lowest values. These trends are consistent with established electrochemical principles for cathode materials. Polyanionic groups can increase the redox potential through inductive effects, where strongly electronegative anionic groups withdraw electron density and stabilize higher TM oxidation states. $^{79,80}$ This effect is especially important in phosphate, sulfate, and related frameworks. $^{81}$ Fluorine-containing frameworks also increase voltage because of the strong electronegativity of fluorine and its ability to modify the local TM bonding environment. $^{80}$ Our predicted specific capacity trends show a slightly different pattern (see SI Figure S6). Oxyfluoride materials have the highest predicted capacities, followed by carbonate, fluoride, pyrophosphate, and borate families. Oxides and sulfides show lower average predicted capacities, similar to what was observed for voltages. Therefore, the most attractive candidates are not necessarily those from a single highest-voltage family, but those that combine a high-voltage anionic chemistry with large capacity.

<!-- page: 6 -->

![Figure 4](images/fig4.jpg)
Figure 4: Predicted voltages of all curated structures across different polyanionic families using the four best-performing ML models, ET, GB, RF, and XGB. The analogous plot for specific capacity is given in the SI Figure S6.

3.4. First-Principles Validations The joint distribution of predicted voltages and capacities further highlights the tradeoff between battery properties in Figure 5. Most screened structures are concentrated below approximately $200 \, mAh g^{-1}$ and $4.0 \, V$ . Only a small fraction of materials occupy the highlighted upper-right region, where the highest energy density, calculated as the product of voltage and capacity, is observed. This reflects the usual compromise in cathode design, where working ion uptake can increase capacity but may occur in structures with lower redox potentials. The top 500 materials, ranked by frequency, belong to MP, OQMD, Aflow, and GNoME. We have identified 46 of our top-500 materials already reported in the MP battery dataset for working ions other than Na (see SI Table S3 for comparisons in voltages and capacities). This is not surprising, given the shared electrochemistry of Na with other working ions such as Li and Mg, but nevertheless further demonstrates the robustness of our approach for identifying valid cathode candidates.

To evaluate the reliability of our ML rankings, representative top candidates from the four databases were subjected to high-throughput DFT calculations (Figure 6, see Section 2.4 for details). The selected candidates were analyzed for their structural and electrochemical properties. The validated materials span multiple chemical families, including fluorides, sulfates, fluorophosphates, pyrophosphates, mixed transition-metal oxides, and phosphate frameworks, highlighting the broad chemical diversity captured by our screening pipeline. Below, we provide more details for each structure.

(a) $\mathrm{VFe}(\mathrm{P}_{2}\mathrm{O}_{7})_{2}$ . This material from the MP database belongs to the mixed transition-metal pyrophosphate family and adopts a 3D framework built from V–O and Fe–O polyhedra connected through $P_{2}O_{7}$ units (Figure 6a). This 3D connectivity is favorable for maintaining structural integrity during Na insertion, as the rigid pyrophosphate groups provide a robust polyanionic backbone while allowing multiple redox-active transition-metal centers to participate in charge compensation. The mixed V/Fe chemistry may also provide enhanced redox flexibility during Na insertion and extraction. The pyrophosphate framework $\mathrm{VFe}(\mathrm{P}_{2}\mathrm{O}_{7})_{2}$ transforms into $\mathrm{Na}_{7}\mathrm{V}_{2}\mathrm{Fe}_{2}(\mathrm{P}_{2}\mathrm{O}_{7})_{4}$ after Na intercalation. This discharged structure preserves the local V/Fe–O and P–O coordination environments, with an overall volume expansion of approximately 13%. Thus, this material represents a structurally robust 3D pyrophosphate host with good Na-ion storage capacity. The ML-predicted mean voltage and capacity are 4.3 V and 169.7 mAh g $^{-1}$ , respectively, whereas DFT calculations yield 3.2 V and 175.3 mAh g $^{-1}$ . Our ML model overestimates the voltage by 1.1 V for this material, but the capacity remains in good agreement with DFT. Our DFT-calculated band gaps for the charged and discharged states are 1.18 and 1.84 eV, respectively, indicating semiconducting electronic character in both states. Semiconducting behavior is commonly observed in polyanionic cathode materials, where strong localization of transition-metal states and the presence of phosphate/pyrophosphate groups often limit the intrinsic electrical conductivity. $^{82}$ The increase in band gap after Na insertion suggests that the sodiated phase may be less electrically conductive than the charged host.

<!-- page: 7 -->

![Figure 5](images/fig5.jpg)
Figure 5: Top 500 global structures with the highest predicted voltages and capacities.

![Figure 6](images/fig6.jpg)
Figure 6: Selected DFT validated structures from each database. (a) $\mathrm{VFe(P_2O_7)_2}$ from MP, (b) $\mathrm{Zn_2O_4}$ from AFLOW, (c) $\mathrm{VCr_3F_{20}}$ from GNoME, and (d) $\mathrm{AgSO_4}$ from OQMD. See the text for more details.

(b) $Zn_{2}O_{4}$ . The AFLOW-derived $Zn_{2}O_{4}$ binary transition-metal oxide adopts a 3D framework. Upon Na insertion, the discharged structure relaxes to $NaZn_{2}O_{4}$ . The predicted and DFT-calculated voltages are in close agreement, with values of 3.6 and 3.7 V, respectively. The mean predicted capacity is 232.5 mAh g $^{-1}$ while the DFT-calculated value is 123.1 mAh g $^{-1}$ . The reduced DFT-calculated capacity likely reflects limited thermodynamically accessible Na insertion sites within the relaxed oxide host.

Also, the volume expansion upon sodiation is calculated to be $\approx11\%$ . The calculated band gaps of both the charged $Zn_{2}O_{4}$ and discharged $NaZn_{2}O_{4}$ phases suggest a metallic character for both states. This behavior contrasts with that of the semiconducting polyanionic candidates and may be beneficial for intrinsic electrical conductivity. Compared to the other three systems, this oxide framework exhibits a rather simpler structural chemistry and lacks the strong inductive enhancement associated with phosphate, sulfate, or fluoride groups. Nevertheless, its 3D Zn–O framework provides a connected host lattice for Na uptake and helps preserve the overall oxide framework after insertion.

(c) $VCr_{3}F_{20}$ . The GNoME-derived candidate represents a 1D, mixed transition-metal fluoride framework. Upon Na insertion, the relaxed discharged structure is $Na_{7}VCr_{3}F_{20}$ . Our ML models predicted an average voltage of 4.6 V and a capacity of 157.1 mAh g $^{-1}$ , while DFT-calculated values are 4.9 V and 250.9 mAh g $^{-1}$ . The high DFT voltage is consistent with the strong inductive effect associated with fluoride coordination, in which highly electronegative F atoms stabilize high oxidation states of transition metals, thereby increasing the redox potential. The framework also contains multiple transition-metal centers, which may contribute to multielectron redox activity and enhanced Na accommodation. The calculated band gaps of the charged VCr3F20 and discharged $Na_{7}VCr3F20$ phases are 1.51 and 1.74 eV, respectively, suggesting semiconducting behavior in both states. This semiconducting behavior is consistent with many fluoride-rich cathode materials, where strong metal–fluorine bonding and localized transition-metal states can limit intrinsic electrical conductivity. $^{83}$ The volume expansion after sodiation is $\approx11\%$ , indicating that this fluoride framework can accommodate substantial amounts of Na ions and withstand significant structural rearrangements or distortions.

(d) $AgSO_{4}$ . This OQMD-derived structure belongs to the 3D sulfate polyanion family. Structurally, Ag–O units in $AgSO_{4}$ are connected through rigid $SO_{4}$ tetrahedra, providing an extended host lattice. After Na insertion, the discharged structure is $NaAgSO_{4}$ . Our ML-predicted mean voltage and capacity are 3.6 V and 200.2 mAh $g^{-1}$ , respectively, while DFT calculations yield 3.7 V and 118.1 mAh $g^{-1}$ . Sulfate frameworks are well known for strong inductive effects arising from highly electronegative sulfate polyanions, which can substantially increase redox potentials. The good agreement between our ML-predicted and the DFT-calculated voltages confirms the model's ability to identify high-voltage sulfate systems. The higher predicted capacity than the DFT-calculated value indicates that the model does not fully capture the limited number of thermodynamically accessible Na sites. The volume expansion after sodiation is approximately 9%. The calculated band gaps of the charged $AgSO_{4}$ and discharged $NaAgSO_{4}$ phases are 0.015 and 2.11 eV, respectively. This demonstrates that the charged state is nearly metallic, whereas the sodiated discharged state is semiconducting. This substantial gap opening after Na insertion suggests a marked change in the electronic structure, likely associated with the reduction of Ag-centered states during the $Ag^{2+}/Ag^{+}$ redox process.

Together, these four DFT-validated candidates demonstrate that our ML models can identify chemically diverse cathode-active candidate materials for SIBs. The fluoride and sulfate materials emphasize the role of strong electronegative anions in raising redox potentials. The pyrophosphate example highlights the stabilizing role of rigid polyanion frameworks and mixed transition-metal redox. The Zn oxide case points to an oxide chemistry that may involve charge compensation. This diversity is important because it shows that the models do not favor a specific cathode family. Rather, they rank candidates across multiple anion chemistries sourced from different databases.

<!-- page: 8 -->
## 3.5. Key Structural and Chemical Features
Our feature importance analysis, shown in Figure 7, demonstrates that elemental features are most important for both voltage and specific capacity. For voltage, the most important features are the periodic table position, Pauling electronegativity calculated from the elemental composition, and atomic size. This indicates that the elements' ability to attract electrons strongly influences the predicted voltage, as voltage is related to redox chemistry and the bonding environment. For specific capacity, the Mendeleev number is the dominant feature, suggesting that variation in elemental character across the composition is a key factor controlling capacity. Structural volume is also an important descriptor for capacity prediction, as it is closely related to a material's density and its ability to accommodate Na ions. Overall, these results indicate that our trained ML models rely on chemically meaningful composition descriptors for voltage and capacity predictions.

![Figure 7](images/fig7.jpg)
Figure 7: Top five features for the (a) voltage and (b) specific capacity predictions. Feature importances are normalized within each model and averaged across the four models.

# 4. CONCLUSIONS
In this work, we have developed a scalable data-driven framework for sodium-ion cathode discovery based on charged-only host structures. By combining a curated large-scale database with fast ML screening, we demonstrated that key electrochemical properties, including average voltage, can be predicted with reasonable accuracy from a single structural state. Tree-based ensemble models showed the best performance and enabled large-scale screening across diverse inorganic chemical spaces, while uncertainty quantification improved the reliability of candidate selection. This framework significantly reduces reliance on expensive high-throughput DFT calculations and provides a scalable, transferable approach for identifying high-voltage cathode materials. Despite these advances, the current workflow is limited to screening existing materials. Future work will extend this framework toward inverse design by integrating chemistry-aware structure generation and reinforcement learning. In this approach, new candidates can be generated through chemically valid modifications of known frameworks and iteratively optimized using ML-driven reward functions. Coupled with selective DFT validation and active learning, this closed-loop strategy will enable autonomous discovery of novel cathode materials with improved electrochemical performance.

## Supporting Information Available
Details of model performance evaluations, performance of crystal graph convolutional neural networks, distribution of the training dataset, sodium insertion workflow for DFT validations, Spearman rank correlation matrices for voltages and capacities, predicted specific capacities, $(R_{1}-R_{10})$ errors across cross-validation folds for voltages and capacities, comparison of calculated voltage and capacity for shared candidate materials in top 500 structures with those from MP battery dataset, and an Excel spreadsheet listing all top-500 materials.

Acknowledgement Simulations presented in this work used resources from Bridges-2 at Pittsburgh Supercomputing Center through allocations PHY230030P and CHE260021P from the Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS) program, $^{84}$ which is supported by National Science Foundation grants #2138259, #2138286, #2138307, #2137603, and #2138296. The authors also acknowledge the HPC center at UMKC for providing computing resources and support.

# References

(1) Tarascon, J.-M.; Armand, M. Issues and challenges facing rechargeable lithium batteries. Nature 2001, 414, 359–367.

(2) Armand, M.; Tarascon, J.-M. Building better batteries. Nature 2008, 451, 652–657.

(3) Goodenough, J. B.; Kim, Y. Challenges for rechargeable batteries. J. Power Sources 2011, 196, 6688–6694.

(4) He, P.; Yu, H.; Zhou, H., et al. Layered lithium transition metal oxide cathodes towards high energy lithium-ion batteries. J. Mater. Chem. 2012, 22, 3680–3695.

(5) Manthiram, A. A reflection on lithium-ion battery cathode chemistry. Nat. Commun. 2020, 11, 1550.

(6) Goodenough, J. B.; Park, K.-S. The Li-ion rechargeable battery: a perspective. J. Am. Chem. Soc. 2013, 135, 1167–1176.

(7) Li, M.; Lu, J.; Chen, Z.; Amine, K. 30 years of lithium-ion batteries. Adv. Mater. 2018, 30, 1800561.

(8) You, Y.; Manthiram, A. Progress in high-voltage cathode materials for rechargeable sodium-ion batteries. Adv. Energy Mater. 2018, 8, 1701785.

(9) Phogat, P.; Dey, S.; Wan, M. Comprehensive review of sodium-ion batteries: Principles, materials, performance, challenges, and future perspectives. Mater. Sci. Eng. B 2025, 312, 117870.

(10) Song, D.; Chen, X.; Lin, Z.; Tang, Z.; Ma, W.; Zhang, Q.; Li, Y.; Zhang, X. Usability identification framework and high-throughput screening of two-dimensional materials in lithium ion batteries. ACS Nano 2021, 15, 16469–16477.

(11) Jeong, J.; Kim, J.; Sun, J.; Min, K. Machine-learning-driven high-throughput screening for high-energy density and stable

<!-- page: 9 -->

NASICON cathodes. ACS Appl. Mater. Interfaces 2024, 16, 24431–24441.

(12) de la Llave, E.; Borgel, V.; Park, K.-J.; Hwang, J.-Y.; Sun, Y.-K.; Hartmann, P.; Chesneau, F.-F.; Aurbach, D. Comparison between Na-ion and Li-ion cells: understanding the critical role of the cathodes stability and the anodes pretreatment on the cells behavior. ACS Appl. Mater. Interfaces 2016, 8, 1867–1875.

(13) Reddy, T. B.; Linden, D. Linden's Handbook of Batteries, 5th ed.; McGraw-Hill Education: New York, 2019.

(14) Hwang, J.-Y.; Myung, S.-T.; Sun, Y.-K. Sodium-ion batteries: present and future. Chem. Soc. Rev. 2017, 46, 3529–3614.

(15) Huang, L.; Zhu, J.; Liu, J.-X.; Wu, H.; Zhang, G.-J. The Emerging High-Entropy Strategy: A Booster to the Development of Cathode Materials for Power Batteries. J. Adv. Ceram. 2024, 13, 1093–1118.

(16) Satrughna, J. A. K.; Kanwade, A.; Srivastava, A.; Tiwari, M. K.; Yadav, S. C.; Akula, S. T.; Shirage, P. M. Experimental and computational advancement of cathode materials for futuristic sodium ion batteries. Mater. Today 2023,

(17) Gupta, P.; Pushpakanth, S.; Haider, M. A.; Basu, S. Understanding the design of cathode materials for Na-ion batteries. ACS Omega 2022, 7, 5605–5614.

(18) Rudola, A.; Rennie, A. J.; Heap, R.; Meysami, S. S.; Lowbridge, A.; Mazzali, F.; Sayers, R.; Wright, C. J.; Barker, J. Commercialisation of high energy density sodium-ion batteries: Faradion's journey and outlook. J. Mater. Chem. A 2021, 9, 8279–8302.

(19) Bauer, A.; Song, J.; Vail, S.; Pan, W.; Barker, J.; Lu, Y. The scale-up and commercialization of nonaqueous Na-ion battery technologies. Adv. Energy Mater. 2018, 8, 1702869.

(20) Broux, T.; Fauth, F.; Hall, N.; Chatillon, Y.; Bianchini, M.; Bamine, T.; Leriche, J.-B.; Suard, E.; Carlier, D.; Reynier, Y., et al. High rate performance for carbon-coated $Na_{3}V_{2}(PO_{4})_{2}F_{3}$ in Na-ion batteries. Small Methods 2019, 3, 1800215.

(21) Peng, C.; Xu, X.; Li, F.; Xi, L.; Zeng, J.; Song, X.; Wan, X.; Zhao, J.; Liu, J. Recent progress of promising cathode candidates for sodium-ion batteries: current issues, strategy, challenge, and prospects. Small Struct. 2023, 4, 2300150.

(22) Yadav, P.; Patrike, A.; Wasnik, K.; Shelke, V.; Shelke, M. Strategies and practical approaches for stable and high energy density sodium-ion battery: a step closer to commercialization. Mater. Today Sustain. 2023, 22, 100385.

(23) Han, M. H.; Gonzalo, E.; Singh, G.; Rojo, T. A comprehensive review of sodium layered oxides: powerful cathodes for Na-ion batteries. Energy Environ. Sci. 2015, 8, 81–102.

(24) Delmas, C.; Braconnier, J.-J.; Fouassier, C.; Hagenmuller, P. Electrochemical intercalation of sodium in $Na_{x}CoO_{2}$ bronzes. Solid State Ion. 1981, 3, 165–169.

(25) Wang, Q.; Zhao, C.; Wagemaker, M. Rational Design of Layered Oxide Materials for Batteries. Acc. Chem. Res. 2025, 58, 1742–1753.

(26) Yabuuchi, N.; Kajiyama, M.; Iwatate, J.; Nishikawa, H.; Hitomi, S.; Okuyama, R.; Usui, R.; Yamada, Y.; Komaba, S. P2-type $Na_{x}[Fe_{1/2}Mn_{1/2}]O_{2}$ made from earth-abundant elements for rechargeable Na batteries. Nat. Mater. 2012, 11, 512–517.

(27) Lavela, S.; Santos, A. C. d. N.; Motta, F. V. d.; Bomio, M. R. D.; Lavela, P.; Pérez Vicente, C.; Tirado, J. L. Improving the Performance of the Layered Nickel Manganese Oxide Cathode of Sodium-Ion Batteries by Direct Coating with Sodium Niobium Oxide. ACS Appl. Mater. Interfaces 2024, 16, 56975–56986.

(28) Ali, G.; Lee, J.-H.; Susanto, D.; Choi, S.-W.; Cho, B. W.; Nam, K.-W.; Chung, K. Y. Polythiophene-wrapped olivine $NaFePO_{4}$ as a cathode for Na-ion batteries. ACS Appl. Mater. Interfaces 2016, 8, 15422–15429.

(29) Trad, K.; Carlier, D.; Croguennec, L.; Wattiaux, A.; Ben Amara, M.; Delmas, C. $\mathrm{NaMnFe_{2}(PO_{4})_{3}}$ alluaudite phase: synthesis, structure, and electrochemical properties as positive electrode in lithium and sodium batteries. Chem. Mater. 2010, 22, 5554–5562.

(30) Boivin, E.; Chotard, J.-N.; Bamine, T.; Carlier, D.; Serras, P.; Palomares, V.; Rojo, T.; Iadecola, A.; Dupont, L.; Bourgeois, L., et al. Vanadyl-type defects in Tavorite-like $NaVPO_{4}F$ : from the average long range structure to local environments. J. Mater. Chem. A 2017, 5, 25044–25055.

(31) Massa, W.; Yakubovich, O. V.; Dimitrova, O. V. Crystal structure of a new sodium vanadyl (IV) fluoride phosphate $Na_{3}\{V_{2}O_{2}F[PO_{4}]_{2}\}$ . Solid State Sciences 2002, 4, 495–501.

(32) Goodenough, J. B.; Hong, H.-P.; Kafalas, J. Fast Na+-ion transport in skeleton structures. Mater. Res. Bull. 1976, 11, 203-220.

(33) Li, W.-J.; Han, C.; Wang, W.; Gebert, F.; Chou, S.-L.; Liu, H.-K.; Zhang, X.; Dou, S.-X. Commercial prospects of existing cathode materials for sodium ion storage. Adv. Energy Mater. 2017, 7, 1700274.

(34) Delmas, C.; Cherkaoui, F.; Nadiri, A.; Hagenmuller, P. A nasicon-type phase as intercalation electrode: $NaTi_{2}(PO_{4})_{3}$ . Mater. Res. Bull. 1987, 22, 631–639.

(35) Wang, J.; Zhu, Y.-F.; Su, Y.; Guo, J.-X.; Chen, S.; Liu, H.-K.; Dou, S.-X.; Chou, S.-L.; Xiao, Y. Routes to high-performance layered oxide cathodes for sodium-ion batteries. Chem. Soc. Rev. 2024, 53, 4230–4301.

(36) Zuo, W.; Innocenti, A.; Zarrabeitia, M.; Bresser, D.; Yang, Y.; Passerini, S. Layered Oxide Cathodes for Sodium-Ion Batteries:

Storage Mechanism, Electrochemistry, and Techno-economics. Acc. Chem. Res. 2023, 56, 284–296.

(37) Ni, Q.; Bai, Y.; Wu, F.; Wu, C. Polyanion-Type Electrode Materials for Sodium-Ion Batteries. Adv. Sci. 2017, 4, 1600275.

(38) Xu, C.; Zhao, J.; Yang, C.; Hu, Y.-S. Polyanionic Cathode Materials for Practical Na-Ion Batteries toward High Energy Density and Long Cycle Life. ACS Cent. Sci. 2023, 9, 1721–1736.

(39) Butler, K. T.; Davies, D. W.; Cartwright, H.; Isayev, O.; Walsh, A. Machine learning for molecular and materials science. Nature 2018, 559, 547–555.

(40) Kirklin, S.; Saal, J. E.; Meredig, B.; Thompson, A.; Doak, J. W.; Aykol, M.; Rühl, S.; Wolverton, C. The Open Quantum Materials Database (OQMD): assessing the accuracy of DFT formation energies. npj Comput. Mater. 2015, 1, 1–15.

(41) Sendek, A. D.; Yang, Q.; Cubuk, E. D.; Duerloo, K.-A. N.; Cui, Y.; Reed, E. J. Holistic computational structure screening of more than 12000 candidates for solid lithium-ion conductor materials. Energy Environ. Sci. 2017, 10, 306–320.

(42) Li, H. H.; Chen, Q.; Ceder, G.; Persson, K. A. Voltage Mining for (De) lithiation-Stabilized Cathodes and a Machine Learning Model for Li-Ion Cathode Voltage. ACS Appl. Mater. Interfaces 2024, 16, 69379–69387.

(43) He, X.; Chen, Y.; Wang, S.; Zhang, G. Employing graph neural networks for predicting electrode average voltages and screening high-voltage sodium cathode materials. ACS Appl. Mater. Interfaces 2024, 16, 24494–24501.

(44) Liers, L.; Mereacre, L.; Li, H.; Mickenbecker, J.; Knapp, M.; Indris, S.; Behrens, M.; Mangelsen, S. Electrochemical Intercalation Reaction of Sodium into the Layered Transition Metal Dichalcogenide $ZrS_{2}$ -Influence of the Electrolyte Solvent. Inorg. Chem. 2025, 64, 18045–18061.

(45) Wei, S.; Xu, S.; Agrawral, A.; Choudhury, S.; Lu, Y.; Tu, Z.; Ma, L.; Archer, L. A. A stable room-temperature sodium-sulfur battery. Nat. Commun. 2016, 7, 11722.

(46) Xu, S.; Dong, H.; Yang, D.; Wu, C.; Yao, Y.; Rui, X.; Chou, S.; Yu, Y. Promising Cathode Materials for Sodium-Ion Batteries from Lab to Application. ACS Cent. Sci. 2023, 9, 2012–2035.

(47) Jain, A.; Ong, S. P.; Hautier, G.; Chen, W.; Richards, W. D.; Dacek, S.; Cholia, S.; Gunter, D.; Skinner, D.; Ceder, G., et al. Commentary: The Materials Project: A materials genome approach to accelerating materials innovation. APL Mater. 2013, 1.

(48) Curtarolo, S.; Setyawan, W.; Hart, G. L.; Jahnatek, M.; Chepulskii, R. V.; Taylor, R. H.; Wang, S.; Xue, J.; Yang, K.; Levy, O., et al. AFLOW: An automatic framework for high-throughput materials discovery. Comput. Mater. Sci. 2012, 58, 218–226.

(49) Draxl, C.; Scheffler, M. NOMAD: The FAIR concept for big data-driven materials science. MRS Bull. 2018, 43, 676–682.

(50) Draxl, C.; Scheffler, M. Handbook of Materials Modeling; Springer, 2019; pp 1–25.

(51) Miró, P.; Audiffred, M.; Heine, T. An atlas of two-dimensional materials. Chem. Soc. Rev. 2014, 43, 6537–6554.

(52) Rasmussen, F. A.; Thygesen, K. S. Computational 2D materials database: electronic structure of transition-metal dichalcogenides and oxides. J. Phys. Chem. C 2015, 119, 13169–13183.

(53) Zhang, Z.; Valente, D. S.; Shi, Y.; Limbu, D. K.; Momeni, M. R.; Shakib, F. A. In Silico High-Throughput Design and Prediction of Structural and Electronic Properties of Low-Dimensional Metal–Organic Frameworks. ACS Appl. Mater. Interfaces 2023, 15, 9494–9507.

(54) Gražulis, S.; Daškevič, A.; Merkys, A.; Chateigner, D.; Lutterotti, L.; Quiros, M.; Serebryanaya, N. R.; Moeck, P.; Downs, R. T.; Le Bail, A. Crystallography Open Database (COD): an open-access collection of crystal structures and platform for world-wide collaboration. \*Nucleic Acids Res.\* 2012, 40, D420–D427.

(55) Mounet, N.; Gibertini, M.; Schwaller, P.; Campi, D.; Merkys, A.; Marrazzo, A.; Sohier, T.; Castelli, I. E.; Cepellotti, A.; Pizzi, G.; Marzari, N. Two-dimensional materials from high-throughput computational exfoliation of experimentally known compounds. Nat. Nanotechnol. 2018, 13, 246–252.

(56) Ong, S. P.; Cholia, S.; Jain, A.; Brafman, M.; Gunter, D.; Ceder, G.; Persson, K. A. The Materials Application Programming Interface (API): A simple, flexible and efficient API for materials data based on REpresentational State Transfer (REST) principles. Comput. Mater. Sci. 2015, 97, 209–215.

(57) Liu, B.; Wang, D.; Avdeev, M.; Shi, S.; Yang, J.; Zhang, W. High-throughput computational screening of Li-containing fluorides for battery cathode coatings. ACS Sustain. Chem. Eng. 2019, 8, 948–957.

(58) Ong, S. P.; Richards, W. D.; Jain, A.; Hautier, G.; Kocher, M.; Cholia, S.; Gunter, D.; Chevrier, V. L.; Persson, K. A.; Ceder, G. Python Materials Genomics (pymatgen): A robust, open-source python library for materials analysis. Comput. Mater. Sci. 2013, 68, 314–319.

(59) Evans, M. L.; Bergsma, J.; Merkys, A.; Andersen, C. W.; Andersson, O. B.; Beltrán, D.; Blokhin, E.; Boland, T. M.; Balderas, R. C.; Choudhary, K., et al. Developments and applications of the OPTIMADE API for materials discovery, design, and data exchange. Digit. Discov. 2024, 3, 1509–1533.

(60) Rose, F.; Toher, C.; Gossett, E.; Oses, C.; Nardelli, M. B.; Fornari, M.; Curtarolo, S. AFLUX: The LUX materials search API for the AFLOW data repositories. Comput. Mater. Sci. 2017, 137, 362–370.

<!-- page: 10 -->

(61) Merchant, A.; Batzner, S.; Schoenholz, S. S.; Aykol, M.; Cheon, G.; Cubuk, E. D. Scaling deep learning for materials discovery. Nature 2023, 624, 80–85.

(62) Pascazio, R.; Chen, Q.; Li, H. H.; Kaplan, A. D.; Persson, K. A. Toward High-Voltage Cathodes for Zinc-Ion Batteries: Discovery Pipeline and Material Design Rules. Chem. Mater. 2025,

(63) Zhou, J.; Shen, L.; Costa, M. D.; Persson, K. A.; Ong, S. P.; Huck, P.; Lu, Y.; Ma, X.; Chen, Y.; Tang, H.; Feng, Y. P. a. 2DMatPedia, an open computational database of two-dimensional materials from top-down and bottom-up approaches. Sci. Data 2019, 6, 86.

(64) Won, J.; Kim, T.; Lee, M.; Davies, D. W.; Lee, G.; Walsh, A.; Soon, A.; Kim, J.-Y.; Shim, W. Mapping cation-eutaxy ternary with a phenomenological model. Nat. Commun. 2025, 16, 5634.

(65) Chen, W.; Lin, Z.; Zhang, X.; Zhou, H.; Zhang, Y. AI-driven accelerated discovery of intercalation-type cathode materials for magnesium batteries. J. Energy Chem. 2025, 108, 40–46.

(66) O'Keefe, M.; Brese, N. Atom sizes and bond lengths in molecules and crystals. J. Am. Chem. Soc. 1991, 113, 3226–3229.

(67) Dembitskiy, A. D.; Humonen, I. S.; Eremin, R. A.; Aksyonov, D. A.; Fedotov, S. S.; Budennyy, S. A. Benchmarking machine learning models for predicting lithium ion migration. npj Comput. Mater. 2025, 11, 131.

(68) Pan, H.; Ganose, A. M.; Horton, M.; Aykol, M.; Persson, K. A.; Zimmermann, N. E.; Jain, A. Benchmarking coordination number prediction algorithms on inorganic crystal structures. Inorg. Chem. 2021, 60, 1590–1603.

(69) Larsen, P. M.; Pandey, M.; Strange, M.; Jacobsen, K. W. Definition of a scoring parameter to identify low-dimensional materials components. Phys. Rev. Mater. 2019, 3, 034003.

(70) Pedregosa, F.; Varoquaux, G.; Gramfort, A.; Michel, V.; Thirion, B.; Grisel, O.; Blondel, M.; Prettenhofer, P.; Weiss, R.; Dubourg, V., et al. Scikit-learn: Machine learning in Python. J. Mach. Learn. Res. 2011, 12, 2825–2830.

(71) Qian, H.; Tang, Z.; Liu, Y.; Liu, X.; Yuan, B. Feature-driven machine learning screening of sodium-ion battery electrodes to support large-scale energy storage. Electrochim. Acta 2025, 537, 146734.

(72) Ganose, A. M.; Sahasrabuddhe, H.; Asta, M.; Beck, K.; Biswas, T.; Bonkowski, A.; Bustamante, J.; Chen, X.; Chiang, Y.; Chrzan, D. C., et al. Atomate2: modular workflows for materials science. Digit. Discov. 2025, 4, 1944–1973.

(73) Kresse, G.; Hafner, J. Ab initio molecular dynamics for liquid metals. Phys. Rev. B 1993, 47, 558–561.

(74) Kresse, G.; Hafner, J. Ab initio molecular-dynamics simulation of the liquid-metal-amorphous-semiconductor transition in germanium. Phys. Rev. B 1994, 49, 14251-14269.

(75) Kresse, G.; Furthmüller, J. Efficiency of ab-initio total energy calculations for metals and semiconductors using a plane-wave basis set. Comput. Mater. Sci. 1996, 6, 15 - 50.

(76) Kresse, G.; Furthmüller, J. Efficient iterative schemes for ab initio total-energy calculations using a plane-wave basis set. Phys. Rev. B 1996, 54, 11169.

(77) Shen, J.-X.; Horton, M.; Persson, K. A. A charge-density-based general cation insertion algorithm for generating new Li-ion cathode materials. npj Comput. Mater. 2020, 6, 161.

(78) Kim, J.; Sari, D.; Chen, Q.; Rutt, A.; Ceder, G.; Persson, K. A. First-principles and experimental investigation of ABO4 zircons as calcium intercalation cathodes. Chem. Mater. 2024, 36, 4444–4455.

(79) Hautier, G.; Jain, A.; Ong, S. P.; Kang, B.; Moore, C.; Doe, R.; Ceder, G. Phosphates as lithium-ion battery cathodes: an evaluation based on high-throughput ab initio calculations. Chem. Mater. 2011, 23, 3495–3508.

(80) Xu, C.; Zhao, J.; Yang, C.; Hu, Y.-S. Polyanionic Cathode Materials for Practical Na-Ion Batteries toward High Energy Density and Long Cycle Life. ACS Cent. Sci. 2023, 9, 1721–1736.

(81) Ling, J.; Karuppiah, C.; Krishnan, S. G.; Reddy, M. V.; Misnon, I. I.; Ab Rahim, M. H.; Yang, C.-C.; Jose, R. Phosphate Polyanion Materials as High-Voltage Lithium-Ion Battery Cathode: A Review. Energ. Fuels 2021, 35, 10428–10450.

(82) Jin, T.; Li, H.; Zhu, K.; Wang, P.-F.; Liu, P.; Jiao, L. Polyanion-type cathode materials for sodium-ion batteries. Chem. Soc. Rev. 2020, 49, 2342–2377.

(83) Kravchyk, K. V.; Zünd, T.; Wörle, M.; Kovalenko, M. V.; Bodnarchuk, M. I. NaFeF $_{3}$ Nanoplates as Low-Cost Sodium and Lithium Cathode Materials for Stationary Energy Storage. Chem. Mater. 2018, 30, 1825–1829.

(84) Boerner, T. J.; Deems, S.; Furlani, T. R.; Knuth, S. L.; Towns, J. ACCESS: Advancing Innovation: NSF's Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support. Practice and Experience in Advanced Research Computing. New York, NY, USA, 2023; pp 173–176.
